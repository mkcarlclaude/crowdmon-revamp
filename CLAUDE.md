# Working notes for agents

Operational facts that are not derivable from the code. Design decisions live in
[`CONTEXT.md`](CONTEXT.md); delivery state lives in [`ROADMAP.md`](ROADMAP.md).

## The home box

```sh
ssh carl@carls-ubuntu
```

Key auth, non-interactive — `ssh -o BatchMode=yes` works, so an agent can drive it
without a human at the keyboard. It is the machine `CONTEXT.md` §2 describes: Ubuntu
26.04, always-on, and the only place the extraction worker and the monitoring stack run.

- **`sudo` needs a password; `docker` does not.** `carl` is in the `docker` group. Every
  unit this repo installs is a systemd **user** unit for exactly that reason — an install
  that needs somebody to type a password is one that cannot be automated. See
  [`deploy/homebox/README.md`](deploy/homebox/README.md).
- **The worker lives in `~/crowdmon`** — compose file, `.env`, update timer. That
  directory is this repo's to change.
- **`~/monitoring-stack/` is not.** Loki, Tempo, Prometheus and the otel-collector are
  shared with unrelated projects and have no checkout anywhere, so a change made there
  cannot be reviewed or rolled back through this repo. **Read it freely** — querying
  Prometheus and Tempo over SSH is how M7 and M8 were verified — and never write to it.
  Crowdmon's telemetry surface stops at what it *exports*.

Useful read-only probes from the box:

```sh
docker ps
curl -s 'http://localhost:9090/api/v1/label/__name__/values'        # Prometheus series
curl -s 'http://localhost:9090/api/v1/query?query=<promql>'
curl -s 'http://localhost:3200/api/search?tags=service.name=crowdmon-worker'  # Tempo
docker compose -f ~/crowdmon/docker-compose.yml logs --tail 50
```

## Production writes

`npx wrangler d1 execute crowdmon --remote` needs `npx wrangler login` first, and
Claude Code's permission classifier blocks production D1 writes. Ask Carl to run those
with `! ` rather than trying to route around it.

## Checks

The commands CI runs are in [`README.md`](README.md) under "Working on it", and
that is the only copy — a second one here would be a second thing to remember to
update the day CI changes.

### Container builds: run them locally first, and run the artifact

`pnpm test` and `go test` do not cover the image builds. When a change touches a
`Dockerfile`, a `requirements*.txt`, or anything a build step *produces*, build it
locally before pushing rather than discovering each failure one CI run at a time.

```sh
docker build --target export -t detector-export:local deploy/detector
docker build -t detector:local deploy/detector
```

**Exit code 0 is not verification when the artifact has a shape.** M11.2's detector
shipped a build that passed and would have failed every request: `torch.onnx.export`
in torch 2.13 defaults to the dynamo exporter, which honours `dynamic_axes` for
inputs, silently drops it for outputs, and overrides `opset_version`. The graph came
out with the prompt count baked in at one. The obvious fix for the error that
preceded it — installing the missing `onnxscript` — *selects* the broken exporter,
so it turns CI green and makes the bug permanent. What caught it was loading the
exported graph and running inference at more than one prompt count; a single-prompt
test passes on the broken graph.

So: assert on what the build emitted, exercise it at more than the one case the
build itself used, and be suspicious of a fix whose whole effect is to make an
error message go away. The HuggingFace checkpoint is cached inside the detector's
export stage, so re-exports are offline and quick.

### Synthetic pointers cannot reproduce a browser's own gestures

Neither jsdom's `userEvent.pointer` nor Chrome DevTools Protocol mouse events start
the gestures the browser owns: HTML5 drag-and-drop, touch scrolling, text selection.
Both replay the pointer stream an *uninterrupted* drag produces, which is the one
case where a drag-to-draw surface cannot fail.

`/admin/verify`'s adjust tool was driven end to end against production and passed —
201, coordinates stored to the last decimal, prediction row untouched — and was
still unusable by hand ([#155](https://github.com/mkcarlclaude/crowdmon-revamp/pull/155)).
An `<img>` is natively draggable, so a real press-and-move tore the frame loose as a
drag ghost and fired `pointercancel`, which the component correctly reads as "the
drag ended". Two harnesses missed it; the first human to try it hit it immediately.

So when a surface handles raw pointer events, the automation checks the *write path*
and nothing about the gesture. Read the element for the attributes that keep the
browser out of the way — `draggable={false}`, `touch-action`, `user-select` — and
test those directly, because replaying the gesture produces a test that passes on
the broken code. For the rest, a hand on a real mouse is the only instrument; say so
rather than reporting the synthetic pass as verification.
