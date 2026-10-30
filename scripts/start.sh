#!/usr/bin/env bash
# Start the Desk Companion server (used by Termux:Boot and for manual runs).
cd "$(dirname "$0")/.." || exit 1
command -v termux-wake-lock >/dev/null && termux-wake-lock
exec python server.py "$@"
