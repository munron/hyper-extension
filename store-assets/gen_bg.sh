#!/bin/zsh
# Generate one premium abstract backdrop with Codex's image tool.
# Usage: gen_bg.sh <relative_out.png> "<art direction prompt>"
export PATH="$HOME/.nvm/versions/node/v22.1.0/bin:$PATH"
set -e
out="$1"; shift
prompt="$*"
mkdir -p "$(dirname "$out")"
codex exec --skip-git-repo-check \
  -c approval_policy='"never"' -c sandbox_mode='"workspace-write"' \
  "Use your image generation tool to generate ONE landscape image at 1536x1024, then copy the resulting PNG to the absolute path $PWD/$out (overwrite if it exists). ART DIRECTION: $prompt  STRICT: a purely ABSTRACT background — absolutely NO text, NO words, NO letters, NO UI panels, NO devices, NO logos, NO charts. Cinematic, premium, high-end fintech product-launch aesthetic, lots of clean negative space. When finished print exactly: SAVED $out" \
  2>&1 | tail -4
