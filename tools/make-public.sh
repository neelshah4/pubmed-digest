#!/usr/bin/env bash
# Prepares this repo to be made PUBLIC.
#
# Two things leak a personal address if the repo is published as-is:
#   1. An early version of src/cli-ingest.ts hardcoded it as the NCBI contact.
#   2. Every commit is authored with it.
# Both are rewritten to the GitHub noreply address, matching the convention used
# for Neel's other public repos.
#
# This REWRITES HISTORY and force-pushes. Only safe because this repo is new and
# has no other clones. Read it before running it.
set -euo pipefail
cd "$(dirname "$0")/.."

NOREPLY="neelshah4@users.noreply.github.com"

echo "Rewriting author/committer email and scrubbing the hardcoded address..."
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter '
  export GIT_AUTHOR_EMAIL="'"$NOREPLY"'"
  export GIT_COMMITTER_EMAIL="'"$NOREPLY"'"
' --tree-filter '
  if [ -f src/cli-ingest.ts ]; then
    sed -i.bak "s/neels31@gmail\.com/pubmed-digest@users.noreply.github.com/g" src/cli-ingest.ts || true
    rm -f src/cli-ingest.ts.bak
  fi
' -- --all

echo
echo "Verifying nothing personal remains in history..."
if git rev-list --all --objects | awk '{print $1}' | while read -r o; do
     git cat-file -t "$o" 2>/dev/null | grep -q blob && \
     git cat-file -p "$o" 2>/dev/null | grep -q "neels31@gmail" && echo hit
   done | grep -q hit; then
  echo "STILL PRESENT in a blob — do not publish. Investigate before continuing."; exit 1
fi
git log --format='%ae' | sort -u | grep -q "neels31@gmail" && { echo "STILL in commit metadata"; exit 1; }
echo "Clean."
echo
echo "Next, and only if the above says Clean:"
echo "  git push --force origin main"
echo "  gh repo edit neelshah4/pubmed-digest --visibility public --accept-visibility-change-consequences"
echo "  gh api -X POST repos/neelshah4/pubmed-digest/pages -f build_type=workflow"
echo
echo "Pages is deployed by .github/workflows/pages.yml, which publishes web/ via"
echo "actions/deploy-pages. Do NOT configure a branch-based source: it would serve"
echo "the repository root, where there is no index.html, and fight the workflow."
