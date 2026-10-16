#!/usr/bin/env bash
# Shim (plan 8G): the batch hunt is gone; one pipeline wake now is the scheduler's --once --now.
set -euo pipefail
cd "$(dirname "$0")"
exec npm run scheduler -- --once --now
