#!/bin/sh
# Keeps the local server (and the relay that feeds aircraft to the hosted site) running: restarts it if it exits,
# with a short backoff. Logs to ballard.log. Stop with: pkill -f tools/run-local.sh; pkill -f "node server.mjs"
cd "$(dirname "$0")/.." || exit 1
while true; do
  node server.mjs >> ballard.log 2>&1
  echo "[run-local] server exited with $?; restarting in 5 s ($(date -u +%FT%TZ))" >> ballard.log
  sleep 5
done
