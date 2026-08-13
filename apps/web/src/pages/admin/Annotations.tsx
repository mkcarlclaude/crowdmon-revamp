import { useState } from "react";
import { Link } from "react-router";
import {
  useAdminVerdictAnnotators,
  useAdminVerdicts,
  useClasses,
  useVideos,
} from "../../api/queries";
import { LabellingStats } from "../../components/LabellingStats";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { VerdictPreviewDialog } from "../../components/VerdictPreviewDialog";

const PAGE_SIZE = 50;

type SourceFilter = "admin" | "anon" | "all";
type VerdictKind = "accept" | "adjust" | "reject";

const VERDICT_KINDS: readonly VerdictKind[] = ["accept", "adjust", "reject"];

/**
 * The filterable state of this page, `source` included (M18, plan §A).
 *
 * `source` used to be its own `useState` next to `offset`, with a
 * hand-written `changeSource` that reset the page on the way in. Folding it
 * into the same object every other filter lives in — and routing every
 * change, `source`'s included, through the one `setFilters` helper below —
 * is what makes "reset the offset" apply to a filter added tomorrow without
 * anyone having to remember to wire it in again.
 */
interface FilterState {
  source: SourceFilter;
  verdict: VerdictKind[];
  classId: number | undefined;
  videoId: string | undefined;
  annotatorId: string | undefined;
  from: number | undefined;
  to: number | undefined;
}

const DEFAULT_FILTERS: FilterState = {
  source: "admin",
  verdict: [],
  classId: undefined,
  videoId: undefined,
  annotatorId: undefined,
  from: undefined,
  to: undefined,
};

/**
 * An admin's Access email renders as itself; an anonymous session id — a
 * bare `crypto.randomUUID()` — renders truncated. `listVerdictAnnotatorsRoute`'s
 * own comment is why: forty raw UUIDs in one dropdown is unusable, and this
 * is the one place that dropdown gets built.
 */
function annotatorLabel(annotatorId: string, source: "admin" | "anon"): string {
  return source === "admin" ? annotatorId : `anon · ${annotatorId.slice(0, 4)}…`;
}

/** An `<input type="date">` value (`YYYY-MM-DD`, parsed in the browser's own local time) to unix seconds. */
function dateInputToUnixSeconds(value: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(`${value}T00:00:00`);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/**
 * `/admin/annotations` (M16, ROADMAP M16.4; M18, plan §A adds five filters
 * and a total, plan §B adds the preview dialog on row click).
 *
 * `LabellingStats` moves here from the deleted `Admin.tsx`'s "Labelling
 * pool" section, unchanged — it lands above the new verdict list rather
 * than on the dashboard, which stays a deliberate placeholder (§Q19 already
 * forbids rebuilding Grafana inside `/admin`, and a pool count is business
 * data with a page of its own to live on).
 *
 * The verdict list defaults to the `admin` tab, matching the IA table's own
 * framing ("the admin's own verdicts") — `source` is CONTEXT.md §Q10's tier,
 * not this admin's own email; every identity on the allowlist shares the
 * `admin` tier, and "all" or "anon" are one click away rather than a second
 * page, because `listVerdicts` already answers both from the same query.
 */
export function AdminAnnotationsPage() {
  const [filters, setFiltersState] = useState<FilterState>(DEFAULT_FILTERS);
  const [offset, setOffset] = useState(0);
  const [previewedId, setPreviewedId] = useState<number | null>(null);

  /**
   * The one door every filter change walks through. A filter change is a
   * new question, not a continuation of the old one — staying on page 3 of
   * "admin, class Paimon" while switching the class would show rows from an
   * offset that means something different under the new combination. Every
   * control below calls this instead of its own `useState` setter, so the
   * reset cannot be forgotten the next time a filter is added.
   */
  function setFilters(patch: Partial<FilterState>) {
    setFiltersState((current) => ({ ...current, ...patch }));
    setOffset(0);
  }

  const classes = useClasses();
  const videos = useVideos();
  const annotators = useAdminVerdictAnnotators();

  const verdicts = useAdminVerdicts({
    limit: PAGE_SIZE,
    offset,
    source: filters.source === "all" ? undefined : filters.source,
    verdict: filters.verdict.length > 0 ? filters.verdict : undefined,
    classId: filters.classId,
    videoId: filters.videoId,
    annotatorId: filters.annotatorId,
    from: filters.from,
    to: filters.to,
  });

  function toggleVerdict(kind: VerdictKind) {
    setFilters({
      verdict: filters.verdict.includes(kind)
        ? filters.verdict.filter((value) => value !== kind)
        : [...filters.verdict, kind],
    });
  }

  const hasNarrowingFilters =
    filters.verdict.length > 0 ||
    filters.classId !== undefined ||
    filters.videoId !== undefined ||
    filters.annotatorId !== undefined ||
    filters.from !== undefined ||
    filters.to !== undefined;

  const previewedVerdict =
    verdicts.data?.verdicts.find((verdict) => verdict.id === previewedId) ?? null;

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-muted-foreground">
          Labelling pool
        </h2>
        <LabellingStats />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm uppercase tracking-wide text-muted-foreground">Verdicts</h2>
          <Tabs
            value={filters.source}
            onValueChange={(value) => setFilters({ source: value as SourceFilter })}
          >
            <TabsList>
              <TabsTrigger value="admin">Admin</TabsTrigger>
              <TabsTrigger value="anon">Anonymous</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* class / verdict / video / annotator / time-range — `source` stays a
            tab above rather than joining this bar, because it is CONTEXT.md
            §Q10's authority tier, not a mere attribute of a row (the original
            comment on that choice, kept). */}
        <div className="flex flex-wrap items-end gap-3 rounded border border-[var(--color-border)] p-3 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Verdict</span>
            <div className="flex gap-1">
              {VERDICT_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={filters.verdict.includes(kind)}
                  onClick={() => toggleVerdict(kind)}
                  className={`rounded border px-2 py-1 text-xs capitalize ${
                    filters.verdict.includes(kind)
                      ? "border-[var(--color-done)] bg-[var(--color-surface)] font-medium"
                      : "border-[var(--color-border)]"
                  }`}
                >
                  {kind}
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Class</span>
            <select
              value={filters.classId ?? ""}
              onChange={(event) =>
                setFilters({
                  classId: event.target.value === "" ? undefined : Number(event.target.value),
                })
              }
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
            >
              <option value="">any class</option>
              {classes.data?.classes.map((klass) => (
                <option key={klass.id} value={klass.id}>
                  {klass.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Video</span>
            <select
              value={filters.videoId ?? ""}
              onChange={(event) =>
                setFilters({ videoId: event.target.value === "" ? undefined : event.target.value })
              }
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
            >
              <option value="">any video</option>
              {videos.data?.videos.map((video) => (
                <option key={video.id} value={video.id}>
                  {video.title ?? video.id}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Annotator</span>
            <select
              value={filters.annotatorId ?? ""}
              onChange={(event) =>
                setFilters({
                  annotatorId: event.target.value === "" ? undefined : event.target.value,
                })
              }
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
            >
              <option value="">anyone</option>
              {annotators.data?.annotators.map((annotator) => (
                <option
                  key={`${annotator.source}:${annotator.annotator_id}`}
                  value={annotator.annotator_id}
                >
                  {annotatorLabel(annotator.annotator_id, annotator.source)} ({annotator.verdicts})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">From</span>
            <input
              type="date"
              onChange={(event) => setFilters({ from: dateInputToUnixSeconds(event.target.value) })}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">To</span>
            <input
              type="date"
              onChange={(event) => setFilters({ to: dateInputToUnixSeconds(event.target.value) })}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
            />
          </label>

          {hasNarrowingFilters && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFilters(DEFAULT_FILTERS)}
            >
              Clear filters
            </Button>
          )}
        </div>

        {verdicts.isPending && <p className="text-sm">Loading…</p>}
        {verdicts.isError && (
          <p role="alert" className="text-sm text-destructive">
            {verdicts.error.message}
          </p>
        )}

        {verdicts.data && (
          <p className="text-xs text-muted-foreground">
            {/* The total this filter combination matches, not the page size —
                the difference between "no results" and "no results for this
                filter combination" needs a count `limit` never cut off. */}
            {verdicts.data.total} {verdicts.data.total === 1 ? "result" : "results"}
          </p>
        )}

        {verdicts.data && verdicts.data.verdicts.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {hasNarrowingFilters
              ? "Nothing matches this filter combination."
              : "Nothing ruled on yet."}
          </p>
        )}

        {verdicts.data && verdicts.data.verdicts.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Frame</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Annotator</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {verdicts.data.verdicts.map((verdict) => (
                <TableRow
                  key={verdict.id}
                  data-testid={`verdict-row-${verdict.id}`}
                  onClick={() => setPreviewedId(verdict.id)}
                  className="cursor-pointer hover:bg-[var(--color-surface)]"
                >
                  <TableCell>
                    <Link
                      to={`/admin/videos/${verdict.video_id}`}
                      // The row's own click opens the preview; this link's
                      // click should go to the video instead of also doing
                      // that, so it stops the row's handler from seeing it.
                      onClick={(event) => event.stopPropagation()}
                      className="font-mono text-xs underline underline-offset-2 hover:text-foreground"
                    >
                      {verdict.video_id} @ {verdict.timestamp_seconds}s
                    </Link>
                  </TableCell>
                  <TableCell>{verdict.class_name}</TableCell>
                  <TableCell>
                    <Badge variant={verdict.verdict === "reject" ? "destructive" : "secondary"}>
                      {verdict.verdict}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{verdict.source}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {annotatorLabel(verdict.annotator_id, verdict.source)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(verdict.created_at * 1000).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {verdicts.data && verdicts.data.total > 0 && (
          <p className="text-xs text-muted-foreground">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, verdicts.data.total)} of{" "}
            {verdicts.data.total}
          </p>
        )}

        {verdicts.data && verdicts.data.total > PAGE_SIZE && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= verdicts.data.total}
              onClick={() => setOffset((current) => current + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        )}
      </section>

      <VerdictPreviewDialog
        verdict={previewedVerdict}
        onOpenChange={(open) => {
          if (!open) setPreviewedId(null);
        }}
      />
    </div>
  );
}
