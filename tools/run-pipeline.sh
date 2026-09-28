#!/bin/sh
# Runs the data pipeline on this machine every hour (ingest what changed, the discovery engines, publish the lake and
# analytics outputs to Hugging Face), the same steps as .github/workflows/pipeline.yml, using this machine's
# Hugging Face login. Logs to lake/_pipeline.log. Stop with: pkill -f tools/run-pipeline.sh
cd "$(dirname "$0")/../platform" || exit 1
PY=.venv/bin/python
LOG=../lake/_pipeline.log
while true; do
  {
    echo "=== $(date -u +%FT%TZ) pipeline start"
    $PY -m bo ingest || echo "ingest: some sources failed"
    $PY -m bo series || echo "series: some sources failed"
    if $PY -m bo engines; then
      $PY - <<'PY'
import datetime as dt
from huggingface_hub import HfApi
cutoff = dt.date.today() - dt.timedelta(days=8)
old = [f"_out/replay/{(cutoff - dt.timedelta(days=i)).isoformat()}/*" for i in range(0, 5)]  # Rewind keeps a week
HfApi().upload_folder(repo_id="x1489/ballard-observatory", repo_type="dataset", folder_path="../lake",
    allow_patterns=["manifest.json", "*/current.parquet", "*/batches/*.parquet", "_out/*", "_out/**/*"],
    delete_patterns=old, commit_message="local pipeline run")
print("published")
PY
    else echo "engines failed; not publishing"; fi
    echo "=== $(date -u +%FT%TZ) pipeline end"
  } >> "$LOG" 2>&1
  sleep 3600
done
