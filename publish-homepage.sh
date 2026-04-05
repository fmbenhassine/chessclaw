#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 \"commit message\"" >&2
  exit 1
}

if [[ $# -lt 1 ]]; then
  usage
fi

message="$*"
repo_root="$(git rev-parse --show-toplevel)"
main_branch="main"
pages_branch="gh-pages"

main_paths=(
  "frontend"
  "index.html"
  "assets/css"
  "assets/js"
  "assets/img"
)

cleanup() {
  if [[ -n "${pages_worktree:-}" && -d "${pages_worktree:-}" ]]; then
    git -C "$repo_root" worktree remove --force "$pages_worktree" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

cd "$repo_root"

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$main_branch" ]]; then
  echo "Run this script from '$main_branch'. Current branch: '$current_branch'." >&2
  exit 1
fi

if ! git show-ref --verify --quiet "refs/heads/$pages_branch"; then
  echo "Branch '$pages_branch' does not exist." >&2
  exit 1
fi

if [[ ! -d "frontend" || ! -f "frontend/index.html" ]]; then
  echo "Expected homepage files under 'frontend/'." >&2
  exit 1
fi

main_changes="$(git status --porcelain -- "${main_paths[@]}")"
if [[ -z "$main_changes" ]]; then
  echo "No homepage changes found to commit on '$main_branch'." >&2
  exit 1
fi

git add -A -- "${main_paths[@]}"

if git diff --cached --quiet -- "${main_paths[@]}"; then
  echo "No staged homepage changes found after refresh." >&2
  exit 1
fi

git commit -m "$message" -- "${main_paths[@]}"

pages_worktree="$(mktemp -d "${TMPDIR:-/tmp}/chessclaw-gh-pages.XXXXXX")"
git worktree add --force "$pages_worktree" "$pages_branch" >/dev/null

find "$pages_worktree" -mindepth 1 -maxdepth 1 ! -name ".git" -exec rm -rf {} +
cp -R "$repo_root/frontend/." "$pages_worktree/"
: > "$pages_worktree/.nojekyll"

git -C "$pages_worktree" add -A

if git -C "$pages_worktree" diff --cached --quiet; then
  echo "No changes to commit on '$pages_branch'." >&2
  exit 1
fi

git -C "$pages_worktree" commit -m "$message"

git switch "$main_branch" >/dev/null

main_head="$(git rev-parse --short HEAD)"
pages_head="$(git -C "$pages_worktree" rev-parse --short HEAD)"

echo "Committed homepage changes on '$main_branch' at $main_head."
echo "Committed homepage changes on '$pages_branch' at $pages_head."
echo "Current branch: $(git branch --show-current)"
