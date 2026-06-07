#!/usr/bin/env bash
set -euo pipefail

script_name="${1:-}"
if [[ -z "$script_name" ]]; then
  echo "Usage: $0 <package-script>" >&2
  exit 2
fi

if [[ ! -f package.json ]]; then
  echo "Skipping ${script_name}: package.json not found"
  exit 0
fi

if node -e "const p = require('./package.json'); process.exit(p.scripts?.[process.argv[1]] ? 0 : 1)" "$script_name"; then
  exec bun run "$script_name"
fi

echo "Skipping ${script_name}: package.json script not configured"
