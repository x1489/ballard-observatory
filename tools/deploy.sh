#!/bin/sh
# Safe deploy of the edge (Worker, Durable Object and static assets): tests first, deploy, smoke-test the live site,
# and roll back to the previous version automatically if the smoke test fails.
set -u
cd "$(dirname "$0")/.." || exit 1
npm test >/tmp/bo-deploy-tests.log 2>&1 || { echo "tests failed; not deploying (see /tmp/bo-deploy-tests.log)"; exit 1; }
PREV=$(cd edge && ./wrangler.sh deployments list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const last=a[a.length-1];console.log(last.versions[0].version_id)}catch{console.log("")}})')
(cd edge && ./wrangler.sh deploy) >/tmp/bo-deploy.log 2>&1 || { echo "deploy failed (see /tmp/bo-deploy.log)"; exit 1; }
sleep 8
if node tools/smoke.mjs; then echo "deployed OK"; exit 0; fi
if [ -n "$PREV" ]; then
  echo "smoke test failed: rolling back to $PREV"
  (cd edge && ./wrangler.sh rollback "$PREV" -y --message "auto rollback: smoke test failed") 2>&1 | tail -3
  sleep 5; node tools/smoke.mjs >/dev/null && echo "rollback OK" || echo "rollback smoke still failing"
fi
exit 1
