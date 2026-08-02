#!/usr/bin/env bash
# Installs the worker onto the home box. Run it from a checkout on the box, or
# copy this directory over and run it there.
#
# No root, anywhere. The units are user units and `carl` is in the docker
# group, so the whole deployment is installable from a non-interactive session
# — which is the difference between a deployment that can be automated and one
# that needs somebody at a keyboard to type a password.
#
# Idempotent: running it again after a change to the compose file or a unit is
# the supported way to apply that change.
set -euo pipefail

target="${HOME}/crowdmon"
units="${HOME}/.config/systemd/user"

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

echo "==> installing compose project into ${target}"
mkdir -p "${target}"
install -m 0644 "${here}/docker-compose.yml" "${target}/docker-compose.yml"

# The env file holds an Access service token, so it is created once and never
# overwritten by a redeploy.
if [[ ! -f "${target}/.env" ]]; then
    install -m 0600 "${here}/.env.example" "${target}/.env"
    echo "    created ${target}/.env from the example — fill it in before starting"
fi

echo "==> installing user units into ${units}"
mkdir -p "${units}"
install -m 0644 "${here}/crowdmon-update.service" "${units}/crowdmon-update.service"
install -m 0644 "${here}/crowdmon-update.timer" "${units}/crowdmon-update.timer"

# Without lingering the user manager stops at logout and the timer stops with
# it, which on a headless box means it would run only while somebody happened
# to be connected.
loginctl enable-linger "$(id -un)"

systemctl --user daemon-reload
systemctl --user enable --now crowdmon-update.timer

echo "==> starting the worker"
cd "${target}"
docker compose pull
docker compose up -d

echo
echo "installed. useful next commands:"
echo "  docker compose -f ${target}/docker-compose.yml logs -f"
echo "  systemctl --user list-timers crowdmon-update.timer"
echo "  journalctl --user -u crowdmon-update.service"
