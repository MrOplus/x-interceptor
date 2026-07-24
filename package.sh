#!/usr/bin/env bash
# Builds the Chrome Web Store upload zip: manifest + src + icons only.
# Bash counterpart to package.ps1, for Linux, macOS and CI. Requires `zip`.
#
# Usage:  bash package.sh      (or ./package.sh after chmod +x)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' is not installed or not on PATH." >&2
  exit 1
fi

version=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' manifest.json \
  | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
if [ -z "$version" ]; then
  echo "error: could not read version from manifest.json" >&2
  exit 1
fi

out="x-interceptor-$version.zip"
rm -f "$out"

# `zip` writes forward-slash entry names natively, which is what the store wants.
zip -r -q "$out" manifest.json src icons -x '*/.DS_Store' '*/Thumbs.db'

echo "Built $out"
zip -sf "$out"
