#!/usr/bin/env bash

set -euo pipefail

# Builds a job image for Cloud Run (linux/amd64), pushes it to Artifact
# Registry, and creates or updates the Cloud Run Job that an app's dispatcher
# starts one execution of per run. The job is deployed by digest, so what runs
# is what was just built; an image built from uncommitted sources is tagged
# <commit>-wip-<time> so it is never mistaken for a release.
#
# Configuration reaches gcloud in a file only this user can read, never in its
# argv. Secrets belong in Secret Manager (--secret); --env-from takes a value
# from this script's environment, keeping it out of argv here as well.
#
# Needs git, docker and gcloud. Run setup-dispatch-federation.sh first to make
# the invoker account.

usage() {
  cat >&2 <<'USAGE'
usage: deploy-job.sh --project PROJECT --region REGION --job JOB --image REPOSITORY
         --dockerfile PATH --service-account EMAIL [options]

  --project          Google Cloud project id
  --region           Cloud Run region, e.g. asia-southeast1
  --job              Cloud Run Job name
  --image            image repository without a tag,
                     e.g. asia-southeast1-docker.pkg.dev/PROJECT/REPO/NAME
  --dockerfile       the Dockerfile to build
  --context          build context (default: the repository's root)
  --repository-root  the git repository the image is built from (default: the
                     one holding --context)
  --source           a path, relative to the repository root, whose uncommitted
                     changes make the tag a wip one; repeatable (default: all)
  --service-account  the identity executions run as, by email
  --invoker          an account allowed to run the job with overrides, by
                     email; repeatable
  --env              NAME=VALUE set on the job; repeatable
  --env-from         NAME, set on the job from this script's environment, which
                     must have it; repeatable
  --env-from-if-set  NAME, as --env-from, but skipped when unset or empty
  --secret           NAME=SECRET[:VERSION], a Secret Manager secret exposed as
                     NAME (version default: latest); repeatable
  --mount-bucket     BUCKET:PATH, a Cloud Storage bucket mounted read-only at
                     PATH; repeatable
  --cpu              default 1
  --memory           default 512Mi
  --task-timeout     default 3600s
  --max-retries      default 0: the dispatcher, not Cloud Run, starts a run again
  --label            KEY=VALUE on the job; repeatable
  --commit-label     the label that records the commit (default: commit)
  --dry-run          print the docker and gcloud commands instead of running them
USAGE
  exit 2
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

project=""
region=""
job=""
image=""
dockerfile=""
context=""
repository_root=""
sources=()
service_account=""
invokers=()
env_pairs=()
env_from=()
env_from_if_set=()
secrets=()
bucket_mounts=()
cpu="1"
memory="512Mi"
task_timeout="3600s"
max_retries="0"
labels=()
commit_label="commit"
dry_run=false

while (($# > 0)); do
  case "$1" in
    --project) project="${2:-}"; shift 2 || usage ;;
    --region) region="${2:-}"; shift 2 || usage ;;
    --job) job="${2:-}"; shift 2 || usage ;;
    --image) image="${2:-}"; shift 2 || usage ;;
    --dockerfile) dockerfile="${2:-}"; shift 2 || usage ;;
    --context) context="${2:-}"; shift 2 || usage ;;
    --repository-root) repository_root="${2:-}"; shift 2 || usage ;;
    --source) sources+=("${2:-}"); shift 2 || usage ;;
    --service-account) service_account="${2:-}"; shift 2 || usage ;;
    --invoker) invokers+=("${2:-}"); shift 2 || usage ;;
    --env) env_pairs+=("${2:-}"); shift 2 || usage ;;
    --env-from) env_from+=("${2:-}"); shift 2 || usage ;;
    --env-from-if-set) env_from_if_set+=("${2:-}"); shift 2 || usage ;;
    --secret) secrets+=("${2:-}"); shift 2 || usage ;;
    --mount-bucket) bucket_mounts+=("${2:-}"); shift 2 || usage ;;
    --cpu) cpu="${2:-}"; shift 2 || usage ;;
    --memory) memory="${2:-}"; shift 2 || usage ;;
    --task-timeout) task_timeout="${2:-}"; shift 2 || usage ;;
    --max-retries) max_retries="${2:-}"; shift 2 || usage ;;
    --label) labels+=("${2:-}"); shift 2 || usage ;;
    --commit-label) commit_label="${2:-}"; shift 2 || usage ;;
    --dry-run) dry_run=true; shift ;;
    -h | --help) usage ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage ;;
  esac
done

[[ -n "$project" && -n "$region" && -n "$job" && -n "$image" && -n "$dockerfile" && -n "$service_account" ]] || usage

env_name='^[A-Za-z_][A-Za-z0-9_]*$'
email='^[a-z0-9-]+@[a-z0-9.-]+\.gserviceaccount\.com$'
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail "--project is not a project id: $project"
[[ "$region" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || fail "--region is not a region: $region"
[[ "$job" =~ ^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail "--job is not a job name: $job"
[[ "$image" =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+$ ]] || fail "--image must be a repository with no tag or digest: $image"
[[ -f "$dockerfile" ]] || fail "no Dockerfile at $dockerfile"
[[ "$service_account" =~ $email ]] || fail "--service-account is not a service account email: $service_account"
for invoker in ${invokers[@]+"${invokers[@]}"}; do
  [[ "$invoker" =~ $email ]] || fail "--invoker is not a service account email: $invoker"
done
[[ "$commit_label" =~ ^[a-z][a-z0-9_-]{0,62}$ ]] || fail "--commit-label is not a label key: $commit_label"
for label in ${labels[@]+"${labels[@]}"}; do
  [[ "$label" =~ ^[a-z][a-z0-9_-]{0,62}=[a-z0-9_-]{0,63}$ ]] || fail "--label must be KEY=VALUE in lowercase: $label"
done
for secret in ${secrets[@]+"${secrets[@]}"}; do
  [[ "$secret" =~ ^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_-]+(:[A-Za-z0-9]+)?$ ]] || fail "--secret must be NAME=SECRET[:VERSION]: $secret"
done
for mount in ${bucket_mounts[@]+"${bucket_mounts[@]}"}; do
  [[ "$mount" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]:/[^,:=]*$ ]] || fail "--mount-bucket must be BUCKET:/PATH: $mount"
done

if [[ -z "$repository_root" ]]; then
  repository_root=$(git -C "${context:-.}" rev-parse --show-toplevel) || fail "--context is not in a git repository"
fi
context="${context:-$repository_root}"
[[ -d "$context" ]] || fail "no build context at $context"

# Values are single-quoted for YAML, so nothing in one is read as YAML. The
# quote is in a variable because bash 3.2 keeps backslashes in a replacement.
yaml_value() {
  local quote="'"
  printf "'%s'" "${1//$quote/$quote$quote}"
}

env_file=$(mktemp)
trap 'rm -f "$env_file"' EXIT
chmod 600 "$env_file"
env_names=()
write_env() {
  [[ "$1" =~ $env_name ]] || fail "not an environment variable name: $1"
  [[ "$2" != *$'\n'* ]] || fail "the value of $1 holds a newline"
  [[ " ${env_names[*]-} " != *" $1 "* ]] || fail "$1 is set twice"
  env_names+=("$1")
  printf '%s: %s\n' "$1" "$(yaml_value "$2")" >>"$env_file"
}
for pair in ${env_pairs[@]+"${env_pairs[@]}"}; do
  [[ "$pair" == *=* ]] || fail "--env must be NAME=VALUE: $pair"
  write_env "${pair%%=*}" "${pair#*=}"
done
for name in ${env_from[@]+"${env_from[@]}"}; do
  [[ "$name" =~ $env_name ]] || fail "not an environment variable name: $name"
  [[ -n "${!name:-}" ]] || fail "export $name first"
  write_env "$name" "${!name}"
done
for name in ${env_from_if_set[@]+"${env_from_if_set[@]}"}; do
  [[ "$name" =~ $env_name ]] || fail "not an environment variable name: $name"
  [[ -z "${!name:-}" ]] || write_env "$name" "${!name}"
done

commit=$(git -C "$repository_root" rev-parse --short=12 HEAD)
if [[ -n "$(git -C "$repository_root" status --porcelain -- ${sources[@]+"${sources[@]}"})" ]]; then
  tag="$commit-wip-$(date -u +%Y%m%dT%H%M%SZ)"
  printf 'The sources have uncommitted changes; tagging %s. Use a clean commit for a release.\n' "$tag" >&2
else
  tag="$commit"
fi

# Prints the command in a dry run, on a descriptor of its own so the
# command's redirects do not hide it, and runs it otherwise.
exec 3>&2
run() {
  if $dry_run; then
    {
      printf '+'
      printf ' %q' "$@"
      printf '\n'
    } >&3
  else
    "$@"
  fi
}

registry="${image%%/*}"
run gcloud auth configure-docker "$registry" --quiet >/dev/null 2>&1
run docker build --platform linux/amd64 -f "$dockerfile" -t "$image:$tag" "$context"
run docker push "$image:$tag"
if $dry_run; then
  digest="$image@sha256:DIGEST"
else
  # The image may carry digests from other repositories; take this one's.
  digest=$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image:$tag" \
    | grep -F "$image@sha256:" | head -n 1 || true)
  [[ "$digest" == "$image@sha256:"* ]] || fail "could not resolve the pushed image's digest"
fi

deploy_flags=(
  --project "$project" --region "$region"
  --image "$digest"
  --service-account "$service_account"
  --tasks 1 --max-retries "$max_retries" --task-timeout "$task_timeout"
  --cpu "$cpu" --memory "$memory"
)
if ((${#env_names[@]} > 0)); then
  deploy_flags+=(--env-vars-file "$env_file")
else
  deploy_flags+=(--clear-env-vars)
fi
if ((${#secrets[@]} > 0)); then
  secret_flags=()
  for secret in "${secrets[@]}"; do
    [[ "$secret" == *:* ]] || secret="$secret:latest"
    secret_flags+=("$secret")
  done
  deploy_flags+=(--set-secrets "$(IFS=,; printf '%s' "${secret_flags[*]}")")
else
  deploy_flags+=(--clear-secrets)
fi
deploy_flags+=(--clear-volumes --clear-volume-mounts)
volume=0
for mount in ${bucket_mounts[@]+"${bucket_mounts[@]}"}; do
  volume=$((volume + 1))
  deploy_flags+=(
    --add-volume "name=bucket-$volume,type=cloud-storage,bucket=${mount%%:*},readonly=true"
    --add-volume-mount "volume=bucket-$volume,mount-path=${mount#*:}"
  )
done
deploy_flags+=(--labels "$(IFS=,; printf '%s' "$commit_label=$commit${labels[*]+,${labels[*]}}")")

if $dry_run && ((${#env_names[@]} > 0)); then
  printf '  with %s from the env file\n' "${env_names[*]}" >&2
fi
run gcloud run jobs deploy "$job" "${deploy_flags[@]}"

for invoker in ${invokers[@]+"${invokers[@]}"}; do
  run gcloud run jobs add-iam-policy-binding "$job" --project "$project" --region "$region" \
    --member "serviceAccount:$invoker" --role roles/run.jobsExecutorWithOverrides >/dev/null
done

printf '%s\n' '' "Deployed $digest" "Job: projects/$project/locations/$region/jobs/$job"
for invoker in ${invokers[@]+"${invokers[@]}"}; do
  printf '%s may run it with overrides.\n' "$invoker"
done
