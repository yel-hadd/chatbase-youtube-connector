#!/bin/sh
# Container entrypoint.
#   (no args)      run `sync` on $SCHEDULE (default: daily 06:17) plus a weekly full run on $FULL_SCHEDULE
#   --once [args]  run a single `sync` and exit (systemd timers, Kubernetes CronJobs)
#   anything else  passed straight to the CLI, e.g. `doctor` or `sync --dry-run`
set -eu
CLI="node /app/dist/cli.js -c ${CONFIG:-/config/chatbase-youtube.yaml}"

ping() { [ -n "${HEALTHCHECK_URL:-}" ] && wget -q -O /dev/null "${HEALTHCHECK_URL}$1" 2>/dev/null || true; }

post_report() {
  if [ -n "${REPORT_WEBHOOK_URL:-}" ] && [ -f /data/report.json ]; then
    wget -q -O /dev/null --header 'content-type: application/json' --post-file /data/report.json "$REPORT_WEBHOOK_URL" || true
  fi
}

run_sync() {
  ping /start
  # Never post a previous run's report: remove it, so a crash leaves no report to send.
  rm -f /data/report.json
  code=0
  $CLI sync --report /data/report.json "$@" || code=$?
  # Report every run, failures included: those are the ones worth seeing.
  post_report
  if [ "$code" -eq 0 ]; then ping ""; else ping "/$code"; fi
  return "$code"
}

if [ "${1:-}" = "--once" ]; then shift; run_sync "$@"; exit $?; fi
# Internal: what the crontab below calls. It exits 0 even when the sync failed, since the
# outcome has already gone to the logs, HEALTHCHECK_URL and REPORT_WEBHOOK_URL.
if [ "${1:-}" = "--run-sync" ]; then shift; run_sync "$@"; exit 0; fi
if [ $# -gt 0 ]; then exec $CLI "$@"; fi

cat > /tmp/crontab <<EOF
${SCHEDULE:-17 6 * * *} /usr/local/bin/entrypoint.sh --run-sync
${FULL_SCHEDULE:-43 4 * * 0} /usr/local/bin/entrypoint.sh --run-sync --full
EOF
echo "chatbase-youtube-sync: schedule '${SCHEDULE:-17 6 * * *}', full re-check '${FULL_SCHEDULE:-43 4 * * 0}'"
exec supercronic -passthrough-logs /tmp/crontab
