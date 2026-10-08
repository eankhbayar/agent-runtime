#!/usr/bin/env bash

set -euo pipefail

# Runs the smoke test on Cloud Run: builds the package and the smoke image,
# deploys it as a Cloud Run Job with --sandbox-launcher and a Cloud Storage
# volume for sessions, runs the "first" phase and then the "second" (a new
# execution that continues the first's session), and saves both logs.
#
#   smoke/cloud-run/deploy.sh --project P --region R --bucket SESSIONS_BUCKET \
#     --service-account SA --logs DIR [--job agent-runtime-smoke] [--image REPO]
#   smoke/cloud-run/deploy.sh ... --delete     # remove the job afterwards
#
# The job and its service account need no roles beyond the bucket's.

job=agent-runtime-smoke
image=""
project="" region="" bucket="" account="" logs="" delete=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) project=$2; shift 2 ;;
    --region) region=$2; shift 2 ;;
    --bucket) bucket=$2; shift 2 ;;
    --service-account) account=$2; shift 2 ;;
    --logs) logs=$2; shift 2 ;;
    --job) job=$2; shift 2 ;;
    --image) image=$2; shift 2 ;;
    --delete) delete=1; shift ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done
: "${project:?--project}" "${region:?--region}" "${bucket:?--bucket}" "${account:?--service-account}" "${logs:?--logs}"
image=${image:-$region-docker.pkg.dev/$project/hkjc/agent-runtime-smoke}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
mkdir -p "$logs"

if [[ $delete == 1 ]]; then
  gcloud run jobs delete "$job" --project "$project" --region "$region" --quiet
  exit 0
fi

(cd "$root" && pnpm build)
tag="$(git -C "$root" rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)"
docker build --platform linux/amd64 -f "$root/smoke/cloud-run/Dockerfile" -t "$image:$tag" "$root"
docker push "$image:$tag" >/dev/null
digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$image:$tag")
key="smoke-$tag"

gcloud beta run jobs deploy "$job" --project "$project" --region "$region" \
  --image "$digest" --service-account "$account" --sandbox-launcher \
  --tasks 1 --max-retries 0 --task-timeout 900s --cpu 2 --memory 4Gi \
  --set-env-vars "SMOKE_SECRET=must-not-reach-the-sandbox,SMOKE_SESSION_KEY=$key,SMOKE_PHASE=first" \
  --clear-volumes --add-volume "name=sessions,type=cloud-storage,bucket=$bucket" \
  --clear-volume-mounts --add-volume-mount "volume=sessions,mount-path=/sessions"

fetch() {
  local execution=$1 file="$logs/$1.log"
  for _ in $(seq 1 30); do
    gcloud logging read --project "$project" --order asc --limit 5000 --format 'value(textPayload)' \
      "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$job\" AND labels.\"run.googleapis.com/execution_name\"=\"$execution\"" \
      > "$file"
    grep -q '^SMOKE-END' "$file" && break
    sleep 10
  done
  printf '\nExecution %s, log saved to %s\n' "$execution" "$file"
  sed -n '/^SUMMARY/,/^SMOKE-END/p' "$file"
}

for phase in first second; do
  execution=$(gcloud run jobs execute "$job" --project "$project" --region "$region" --wait \
    --update-env-vars "SMOKE_PHASE=$phase" --format 'value(metadata.name)')
  fetch "$execution"
done
