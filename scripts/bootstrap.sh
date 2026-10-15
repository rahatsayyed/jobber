#!/usr/bin/env bash
# scripts/bootstrap.sh: get Node and dependencies in place, then hand over to scripts/bootstrap.ts.
# Prints every command before running it. No script downloads, no piping into a shell.
set -euo pipefail

cd "$(dirname "$0")/.."

YES=0
CHECK=0
ALLOW_SUDO=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --check|--plan) CHECK=1 ;;
    --allow-sudo) ALLOW_SUDO=1 ;;
  esac
done

if [ "$(id -u)" = "0" ]; then
  echo "bootstrap: do not run as root (npm and Homebrew do not support it)" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "bootstrap: git is missing; install it first (macOS: xcode-select --install, Debian or Ubuntu: sudo apt-get install -y git)" >&2
  exit 1
fi

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) echo "bootstrap: unsupported platform: $OS" >&2; exit 4 ;;
esac

NEED=20
if [ -f package.json ]; then
  N="$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"[^0-9"]*\([0-9][0-9]*\).*/\1/p' package.json | head -n 1)"
  if [ -n "$N" ]; then NEED="$N"; fi
fi

# confirm <prompt>: returns 0 when the owner agrees.
confirm() {
  if [ "$YES" = "1" ]; then return 0; fi
  if ! ( : < /dev/tty ) 2>/dev/null; then
    echo "bootstrap: no terminal to ask on; rerun with --yes" >&2
    exit 3
  fi
  printf '%s [y/N] ' "$1" > /dev/tty
  read -r ans < /dev/tty || ans=""
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge "$NEED" ] 2>/dev/null
}

if ! node_ok; then
  if [ "$CHECK" = "1" ]; then
    echo "bootstrap: Node $NEED or newer is missing (check only, nothing installed)"
    if [ "$OS" = "Darwin" ] && ! command -v brew >/dev/null 2>&1; then
      echo "Install Homebrew from https://brew.sh then rerun this script."
    fi
    exit 1
  elif [ "$OS" = "Darwin" ]; then
    if ! command -v brew >/dev/null 2>&1; then
      echo "bootstrap: Node $NEED or newer is needed and Homebrew is missing."
      echo "Install Homebrew from https://brew.sh then rerun this script."
      exit 1
    fi
    echo "will run: brew install node"
    if confirm "run it?"; then
      brew install node
    else
      echo "bootstrap: declined"
      exit 1
    fi
  else
    CAND=0
    if command -v apt-cache >/dev/null 2>&1; then
      CAND="$(apt-cache policy nodejs 2>/dev/null | sed -n 's/^[[:space:]]*Candidate:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)"
      CAND="${CAND:-0}"
    fi
    if [ "$CAND" -ge "$NEED" ] 2>/dev/null; then
      echo "will run: sudo apt-get install -y nodejs npm"
      if [ "$YES" = "1" ] && [ "$ALLOW_SUDO" != "1" ]; then
        echo "bootstrap: --yes does not cover sudo; add --allow-sudo or run the command yourself" >&2
        exit 1
      fi
      if [ "$ALLOW_SUDO" = "1" ] || confirm "run it with sudo?"; then
        sudo apt-get install -y nodejs npm
      else
        echo "bootstrap: declined"
        exit 1
      fi
    else
      echo "bootstrap: no apt package of Node $NEED or newer. Install one yourself:"
      echo "  nvm: https://github.com/nvm-sh/nvm#installing-and-updating"
      echo "  NodeSource: https://github.com/nodesource/distributions"
      exit 1
    fi
  fi
fi

if [ "$CHECK" != "1" ] && [ ! -x node_modules/.bin/tsx ]; then
  echo "will run: npm ci"
  if confirm "run it?"; then
    npm ci
  else
    echo "bootstrap: declined"
    exit 1
  fi
fi

exec npx tsx scripts/bootstrap.ts "$@"
