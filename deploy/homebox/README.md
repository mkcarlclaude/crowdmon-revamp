# Deploying the worker to the home box

The worker runs as a container on `carls-ubuntu`, alongside the monitoring
stack but not inside it. This directory is the whole deployment: a compose
project, a systemd timer that keeps the image current, and the script that
installs both.

## Why it is separate from the monitoring stack

That stack is shared with unrelated projects, and the directory it runs from
is not a checkout of any repository (`CONTEXT.md` §9.7) — the box is its
source of truth and the two can drift silently. Adding a service to it would
mean this project's releases could take Grafana down, and that a `git pull`
here could never be the way to change anything there. Ownership follows the
blast radius, the same argument §6 makes for the tunnel.

Nothing is lost by the separation: the worker makes only outbound calls, so
it needs no shared network. Its spans go to `otlp.mkcarl.com` over the public
internet through Access, exactly as the Cloudflare Worker's do.

## Install

From a checkout on the box:

```sh
deploy/homebox/install.sh
```

It copies the compose file to `~/crowdmon`, installs and enables the update
timer, and starts the worker. On the first run it also creates `~/crowdmon/.env`
from `.env.example` — **fill that in before the worker will start**, since it
holds the API base URL and the Access service token. A later run never
overwrites it.

**Nothing here needs root.** The units are systemd *user* units and `carl` is
in the `docker` group, so the whole deployment installs from a non-interactive
session. That is not a detail: an install that needs somebody to type a sudo
password is one that cannot be automated, and this box is administered over
SSH from elsewhere. `loginctl enable-linger` is what keeps the user manager —
and therefore the timer — running with nobody logged in.

The script is idempotent. Changing the compose file or a unit here and running
it again is the supported way to apply that change.

## How updates reach the box

Nothing is built here. `publish-worker.yml` builds the image on merge to main
and pushes it to GHCR; `crowdmon-update.timer` fires four times a day, pulls
`ghcr.io/mkcarlclaude/crowdmon-worker:latest`, restarts the container if the
digest moved, and prunes the image the pull left dangling.

The package must be **public** for the box to pull it anonymously. GHCR
creates it private and the API cannot change that — it is a one-time click
under Packages → `crowdmon-worker` → Package settings.

## Checking on it

```sh
docker compose -f ~/crowdmon/docker-compose.yml logs -f
docker compose -f ~/crowdmon/docker-compose.yml images   # running digest
systemctl --user list-timers crowdmon-update.timer
journalctl --user -u crowdmon-update.service
```

Logs are JSON, one line per record, carrying the `trace_id` of the span each
was emitted under — `docker compose logs | jq` is the intended reading, and
the trace itself is in Tempo.

## Reboots

`restart: unless-stopped` brings the container back with Docker, which is
enabled at boot. The timer is `Persistent=true` so a box that was off through
a scheduled run catches up rather than staying a release behind, and lingering
means the user manager starts it without a login. A container stopped
deliberately stays stopped across a reboot, which is the point of
`unless-stopped` over `always`.

**That last sentence has a sharp edge.** Docker suppresses the restart policy
for any container stopped by hand — `docker stop`, `docker kill`, `docker
compose stop` — and it stays suppressed until the container is started again.
So a container you stopped to poke at something will *not* come back after a
reboot, and `docker inspect` still cheerfully reports
`RestartPolicy=unless-stopped` while it sits there. Always finish with:

```sh
docker compose -f ~/crowdmon/docker-compose.yml up -d
```

This also means `docker kill` is worthless as a test of the restart policy —
it exercises exactly the path Docker exempts. To test recovery from a crash,
signal the process instead:

```sh
docker exec crowdmon-worker sh -c 'kill -TERM 1'
docker inspect crowdmon-worker --format '{{.RestartCount}}'   # should increment
```
