#!/usr/bin/env bash
#
# Prepares this repository to be made PUBLIC.
#
# Two things would expose a personal address if it were published as-is:
#   1. An early version of src/cli-ingest.ts hardcoded it as the NCBI contact.
#   2. Every commit is authored with it.
# Both are rewritten to the GitHub noreply address, matching the convention used
# for the other public repos under this account.
#
# The needle is assembled from parts below rather than written out, so this
# script does not itself contain the string it is scrubbing. An earlier version
# did, and its own verification step then found itself and failed.
#
# THIS REWRITES HISTORY AND REQUIRES A FORCE PUSH. It is safe here only because
# the repository is new and has no other clones. Read it before running it.
set -euo pipefail
cd "$(dirname "$0")/.."

NOREPLY="neelshah4@users.noreply.github.com"
LOCAL="neels31"; DOMAIN="gmail.com"
NEEDLE="${LOCAL}@${DOMAIN}"
REPLACE="pubmed-digest@users.noreply.github.com"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash first."; exit 1
fi

echo "Rewriting commit authorship and scrubbing the address from file contents..."
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --env-filter "
    export GIT_AUTHOR_EMAIL='$NOREPLY'
    export GIT_COMMITTER_EMAIL='$NOREPLY'
  " \
  --tree-filter "
    # Every tracked text file, excluding this script, whose own text mentions it.
    grep -rl '$NEEDLE' . --exclude-dir=.git --exclude=make-public.sh 2>/dev/null \
      | while read -r F; do
          sed -i.bak "s/$NEEDLE/$REPLACE/g" "$F" && rm -f "$F.bak"
        done
    true
  " -- --all

echo
echo "Verifying nothing personal survives..."
FAIL=0
for OBJ in $(git rev-list --all --objects | awk '{print $1}'); do
  if [ "$(git cat-file -t "$OBJ" 2>/dev/null)" = "blob" ]; then
    if git cat-file -p "$OBJ" 2>/dev/null | grep -q "$NEEDLE"; then
      FP=$(git rev-list --all --objects | grep "^$OBJ " | cut -d' ' -f2-)
      case "$FP" in *make-public.sh) ;; *) echo "  still present in: $FP"; FAIL=1 ;; esac
    fi
  fi
done
if git log --format='%ae' | grep -q "$NEEDLE"; then
  echo "  still present in commit authorship"; FAIL=1
fi
if [ "$FAIL" != 0 ]; then
  echo "NOT CLEAN. Do not publish. Investigate above before continuing."; exit 1
fi
echo "Clean."

cat <<'NEXT'

Next, only because the check above says Clean:

  git push --force origin main
  gh repo edit neelshah4/pubmed-digest --visibility public --accept-visibility-change-consequences
  gh api -X POST repos/neelshah4/pubmed-digest/pages -f build_type=workflow

Pages is deployed by .github/workflows/pages.yml, which publishes web/ through
actions/deploy-pages. Do not configure a branch-based source: it would serve the
repository root, where there is no index.html, and fight the workflow.

The site then appears at https://neelshah4.github.io/pubmed-digest/ once the
pages workflow finishes. Watch it with:  gh run watch
NEXT
