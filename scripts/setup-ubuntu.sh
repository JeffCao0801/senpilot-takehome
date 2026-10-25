#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo 'Install Node.js 24 or newer from https://nodejs.org/en/download, then rerun this script.' >&2
  exit 1
fi
if ! command -v codex >/dev/null; then
  echo 'Codex CLI is required. Install it using the official OpenAI instructions, then rerun.' >&2
  exit 1
fi
npm ci
npx playwright install --with-deps chromium
if [[ ! -f .env ]]; then
  install -m 600 .env.example .env
  echo 'Created .env. Set the AgentMail key and inbox there; do not paste keys into chat.'
else
  chmod 600 .env
fi
mkdir -p data
chmod 700 data
echo 'Dependencies installed. Follow docs/UBUNTU.md to sign in and install the user service.'
codex --version
