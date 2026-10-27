#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Run this installer on the Ubuntu laptop.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || {
  echo 'Install Node.js 24+ and npm, then rerun.' >&2; exit 1;
}
command -v codex >/dev/null || { echo 'Install Codex CLI, then rerun.' >&2; exit 1; }
sudo apt-get update
sudo apt-get install -y zip unzip file poppler-utils
npm ci
# Use the browser revision belonging to this MCP package, not the root project.
./node_modules/.bin/playwright install --with-deps chromium
if [[ ! -f .env ]]; then
  install -m 600 .env.example .env
else
  chmod 600 .env
fi
npm run configure
echo 'Prepared only. Add the inbox-scoped key to .env and follow README.md for login and acceptance.'
echo 'No service has been enabled and no email has been sent.'
