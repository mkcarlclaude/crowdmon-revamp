import { useState } from "react";
import { Link } from "react-router";
import { useAdminVerdicts } from "../../api/queries";
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

const PAGE_SIZE = 50;

type SourceFilter = "admin" | "anon" | "all";

/**
 * `/admin/annotations` (M16, ROADMAP M16.4): "what did I label" and "how
 * much is labelled" as one page, per the plan's own words.
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
  const [source, setSource] = useState<SourceFilter>("admin");
  const [offset, setOffset] = useState(0);

  const verdicts = useAdminVerdicts({
    limit: PAGE_SIZE,
    offset,
    source: source === "all" ? undefined : source,
  });

  function changeSource(value: string) {
    setSource(value as SourceFilter);
    // A filter change is a new question, not a continuation of the old one
    // — staying on page 3 of "admin" while switching to "anon" would show
    // rows from an offset that means something different in each tier.
    setOffset(0);
  }

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
          <Tabs value={source} onValueChange={changeSource}>
            <TabsList>
              <TabsTrigger value="admin">Admin</TabsTrigger>
              <TabsTrigger value="anon">Anonymous</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {verdicts.isPending && <p className="text-sm">Loading…</p>}
        {verdicts.isError && (
          <p role="alert" className="text-sm text-destructive">
            {verdicts.error.message}
          </p>
        )}
        {verdicts.data && verdicts.data.verdicts.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing ruled on yet.</p>
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
                <TableRow key={verdict.id}>
                  <TableCell>
                    <Link
                      to={`/admin/videos/${verdict.video_id}`}
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
                    {verdict.annotator_id}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(verdict.created_at * 1000).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* No total on this endpoint (CONTEXT.md §Q19 amendment: the tables
            are small and a cursor is complexity nothing here pays for), so
            "Next" is enabled by a full page rather than a known remainder —
            the same offset-paging idiom `LabellingSession`'s own batch
            cursor uses for the same reason. */}
        {verdicts.data && (offset > 0 || verdicts.data.verdicts.length === PAGE_SIZE) && (
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
              disabled={verdicts.data.verdicts.length < PAGE_SIZE}
              onClick={() => setOffset((current) => current + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
