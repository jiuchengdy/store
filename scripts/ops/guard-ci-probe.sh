#!/bin/sh
# Guard: the CI workflows must never call verify-credentials.ts directly.
#
# Why: verify-credentials.ts publishes exit codes intended for restore-drill.sh
# only (3 = nothing to probe, 4 = key missing, 6 = key file unsafe). restore-drill
# translates them into its own table. If a workflow called the probe directly,
# its 3 ("no inventory rows") would collide with restore-drill's 3 ("no dump
# found") inside the same CI run, and the two mean opposite things.
#
# Design note: a missing/renamed workflow directory must FAIL, not pass. A guard
# that cannot read its subject is not a guard — grep exit 2 (error) is treated
# as a failure, not as "no match".
#
# Exit codes:
#   0 = clean (no direct call, and the workflows directory was readable)
#   1 = violation, or the guard could not read its subject
set -eu

WORKFLOWS_DIR="${WORKFLOWS_DIR:-.github/workflows}"

if [ ! -d "$WORKFLOWS_DIR" ]; then
  printf 'guard: workflows directory not found: %s (cannot prove the invariant)\n' "$WORKFLOWS_DIR" >&2
  exit 1
fi

status=0
out="$(grep -rn 'verify-credentials' "$WORKFLOWS_DIR" 2>&1)" || status=$?

case "$status" in
  0)
    printf '%s\n' "$out" >&2
    printf 'guard: FAILED — a workflow calls verify-credentials.ts directly; use restore-drill.sh instead\n' >&2
    exit 1
    ;;
  1)
    printf 'guard: ok — no workflow calls verify-credentials.ts directly\n'
    exit 0
    ;;
  *)
    printf '%s\n' "$out" >&2
    printf 'guard: FAILED — could not read %s (grep exit %s); refusing to pass\n' "$WORKFLOWS_DIR" "$status" >&2
    exit 1
    ;;
esac
