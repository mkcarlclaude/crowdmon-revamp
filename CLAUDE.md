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

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test    # TypeScript
cd worker && go vet ./... && go test ./...  # Go
```

CI runs exactly these.
