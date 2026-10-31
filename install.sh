#!/bin/sh
# OpenBooks installer for macOS and Linux:
#   curl -fsSL https://github.com/doktorigi/openbooks/releases/latest/download/install.sh | sh
# Re-run it to upgrade; your books (books.db) are kept. Set OPENBOOKS_DIR to install elsewhere.
set -eu
DIR="${OPENBOOKS_DIR:-$HOME/openbooks}"

if ! command -v node >/dev/null 2>&1 || ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a==22&&b>=13)?0:1)"; then
  echo "OpenBooks needs Node.js 22.13 or newer. Install it from https://nodejs.org (or your package manager) and run this again." >&2
  exit 1
fi

echo "Downloading OpenBooks to $DIR ..."
mkdir -p "$DIR"
curl -fsSL https://github.com/doktorigi/openbooks/releases/latest/download/openbooks.tar.gz | tar -xz -C "$DIR" --strip-components=1

echo
echo "OpenBooks is installed in $DIR"
echo "Start it with:  cd \"$DIR\" && npm start"
echo "Then open http://localhost:3000 and create your login."
