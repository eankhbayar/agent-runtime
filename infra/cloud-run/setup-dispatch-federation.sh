#!/usr/bin/env bash

set -euo pipefail

# One-time, idempotent setup that lets a Convex deployment act as Google service
# accounts without a service-account key. Convex signs its own JWT with the key
# made here; a workload identity provider holds only the public JWKS and accepts
# only one subject, which may impersonate the accounts named with --account.
# Give each account only what its one job needs: an invoker gets
# roles/run.jobsExecutorWithOverrides on its job from deploy-job.sh, a reader
# gets objectViewer on one bucket from --read-bucket.
#
# Rerunning is safe only while the signing key still exists: a missing key is
# made again and replaces the provider's JWKS, so Convex must then be given the
# new key.
#
# Needs gcloud, openssl and Node 22.18+, and this package built (dist/ is in an
# installed tag; run `pnpm build` in a checkout).

usage() {
  cat >&2 <<'USAGE'
usage: setup-dispatch-federation.sh --project PROJECT --pool POOL --provider PROVIDER
         --issuer URL --subject SUBJECT --signing-key PATH --account NAME...
         [--read-bucket NAME=BUCKET]... [--dry-run]

  --project       Google Cloud project id
  --pool          workload identity pool id, made if missing
  --provider      OIDC provider id in the pool, made if missing, else updated
  --issuer        the `iss` Convex signs with, e.g. https://dispatch.myapp.invalid
  --subject       the one `sub` the provider accepts
  --signing-key   where the RSA signing key is kept; made, mode 600, if missing
  --account       a service account id the subject may impersonate, made if
                  missing; repeat for each
  --read-bucket   give account NAME objectViewer on gs://BUCKET; repeatable
  --dry-run       print the gcloud commands instead of running them; reads
                  nothing from Google and makes no key
USAGE
  exit 2
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
package_root=$(cd -- "$script_directory/../.." && pwd -P)

project=""
pool=""
provider=""
issuer=""
subject=""
key_path=""
accounts=()
bucket_reads=()
dry_run=false

while (($# > 0)); do
  case "$1" in
    --project) project="${2:-}"; shift 2 || usage ;;
    --pool) pool="${2:-}"; shift 2 || usage ;;
    --provider) provider="${2:-}"; shift 2 || usage ;;
    --issuer) issuer="${2:-}"; shift 2 || usage ;;
    --subject) subject="${2:-}"; shift 2 || usage ;;
    --signing-key) key_path="${2:-}"; shift 2 || usage ;;
    --account) accounts+=("${2:-}"); shift 2 || usage ;;
    --read-bucket) bucket_reads+=("${2:-}"); shift 2 || usage ;;
    --dry-run) dry_run=true; shift ;;
    -h | --help) usage ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage ;;
  esac
done

[[ -n "$project" && -n "$pool" && -n "$provider" && -n "$issuer" && -n "$subject" && -n "$key_path" ]] || usage
((${#accounts[@]} > 0)) || usage
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail "--project is not a project id: $project"
[[ "$pool" =~ ^[a-z0-9-]{4,32}$ ]] || fail "--pool is not a pool id: $pool"
[[ "$provider" =~ ^[a-z0-9-]{4,32}$ ]] || fail "--provider is not a provider id: $provider"
[[ "$issuer" == https://* ]] || fail "--issuer must be an https URL"
# The subject lands inside a CEL string in the attribute condition.
[[ "$subject" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "--subject may hold only letters, digits and . _ : -"
for account in "${accounts[@]}"; do
  [[ "$account" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail "--account is not a service account id: $account"
done
for read in ${bucket_reads[@]+"${bucket_reads[@]}"}; do
  [[ "$read" =~ ^([a-z0-9-]+)=([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])$ ]] || fail "--read-bucket must be NAME=BUCKET: $read"
  [[ " ${accounts[*]} " == *" ${BASH_REMATCH[1]} "* ]] || fail "--read-bucket names an account not given with --account: ${BASH_REMATCH[1]}"
done
jwks_script="$script_directory/signing-jwks.mjs"
[[ -f "$package_root/dist/dispatch/cloud-run/index.js" ]] || fail "dist/ is missing; run pnpm build in $package_root"

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

# A dry run asks Google nothing, so everything reads as missing.
exists() {
  $dry_run && return 1
  "$@" >/dev/null 2>&1
}

if $dry_run; then
  project_number="PROJECT_NUMBER"
else
  project_number=$(gcloud projects describe "$project" --format='value(projectNumber)')
fi
provider_name="projects/$project_number/locations/global/workloadIdentityPools/$pool/providers/$provider"
principal="principal://iam.googleapis.com/projects/$project_number/locations/global/workloadIdentityPools/$pool/subject/$subject"

jwks_file=$(mktemp)
trap 'rm -f "$jwks_file"' EXIT
if [[ -f "$key_path" ]]; then
  chmod 600 "$key_path"
elif $dry_run; then
  printf '+ would make an RSA-2048 signing key at %s\n' "$key_path" >&2
else
  mkdir -p "$(dirname -- "$key_path")"
  (umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$key_path" 2>/dev/null)
  printf 'Made a signing key at %s\n' "$key_path"
fi
if [[ -f "$key_path" ]]; then
  node "$jwks_script" "$key_path" >"$jwks_file"
fi

if ! exists gcloud iam workload-identity-pools describe "$pool" --project "$project" --location global; then
  run gcloud iam workload-identity-pools create "$pool" --project "$project" --location global \
    --display-name "Convex dispatch"
fi

provider_flags=(
  --project "$project" --location global --workload-identity-pool "$pool"
  --issuer-uri "$issuer" --jwk-json-path "$jwks_file"
  --attribute-mapping "google.subject=assertion.sub"
  --attribute-condition "assertion.sub == '$subject'"
)
if exists gcloud iam workload-identity-pools providers describe "$provider" \
  --project "$project" --location global --workload-identity-pool "$pool"; then
  run gcloud iam workload-identity-pools providers update-oidc "$provider" "${provider_flags[@]}"
else
  run gcloud iam workload-identity-pools providers create-oidc "$provider" "${provider_flags[@]}" \
    --display-name "Convex"
fi

emails=()
for account in "${accounts[@]}"; do
  email="$account@$project.iam.gserviceaccount.com"
  emails+=("$email")
  if ! exists gcloud iam service-accounts describe "$email" --project "$project"; then
    run gcloud iam service-accounts create "$account" --project "$project" \
      --display-name "$account (Convex dispatch)"
  fi
  run gcloud iam service-accounts add-iam-policy-binding "$email" --project "$project" \
    --role roles/iam.workloadIdentityUser --member "$principal" --condition None >/dev/null
done

for read in ${bucket_reads[@]+"${bucket_reads[@]}"}; do
  account="${read%%=*}"
  bucket="${read#*=}"
  run gcloud storage buckets add-iam-policy-binding "gs://$bucket" --project "$project" \
    --role roles/storage.objectViewer --member "serviceAccount:$account@$project.iam.gserviceaccount.com" >/dev/null
done

printf '%s\n' '' 'Federation is ready. For Convex:' \
  "  workload identity provider: $provider_name" \
  "  issuer: $issuer" \
  "  subject: $subject" \
  "  signing key: the contents of $key_path"
printf '  may impersonate: %s\n' "${emails[@]}"
printf '%s\n' '' 'Deploy the job with deploy-job.sh --invoker <email> to let an account run it.'
