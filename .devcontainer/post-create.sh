#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="$HOME/.bun/bin"
LOCAL_BIN="$HOME/.local/bin"
EXTRA_PATH="$BUN_BIN:$LOCAL_BIN:$PATH"

ensure_path_line() {
  local file="$1"
  local line='export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"'
  touch "$file"
  if ! grep -Fq "$line" "$file"; then
    printf '\n%s\n' "$line" >> "$file"
  fi
}

ensure_path_line "$HOME/.bashrc"
ensure_path_line "$HOME/.zshrc"

export PATH="$EXTRA_PATH"

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$EXTRA_PATH"
fi

npm i -g @openai/codex@latest

if ! command -v opencode >/dev/null 2>&1; then
  curl -fsSL https://opencode.ai/install | bash
  export PATH="$EXTRA_PATH"
fi

(cd "$REPO_ROOT/cli" && npm install && npm run build)

printf '\nCodespaces bootstrap finished.\n'
printf 'Next step inside the codespace:\n'
printf '  bash scripts/codespaces/start-stack.sh\n'
