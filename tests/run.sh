#!/usr/bin/env bash
# Run all checks. Usage: bash tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
NODE="${NODE:-node}"
PY="${PY:-python3}"

echo "### 一致性校验"
"$PY" tests/validate.py "$PWD"

echo
echo "### 语法校验"
mkdir -p /tmp/lccheck
for f in src/background.js src/config.js src/prompts.js src/providers.js src/probe.js src/markdown.js src/archive.js src/sidepanel.js src/manual-notes.js src/notes.js bridge/lib.mjs bridge/obsidian.mjs bridge/server.mjs bridge/start.mjs; do
  cp "$f" "/tmp/lccheck/$(basename "$f").mjs"
  "$NODE" --check "/tmp/lccheck/$(basename "$f").mjs" && echo "  OK(module)  $f"
done
for f in src/content.js src/hook.js; do
  "$NODE" --check "$f" && echo "  OK(classic) $f"
done

echo
echo "### 归档写入模块测试"
"$NODE" bridge/obsidian.test.mjs

echo
echo "### 逻辑测试"
"$NODE" tests/logic.test.mjs "$PWD"

"$NODE" tests/sidepanel.test.mjs

"$NODE" tests/archive-summary.test.mjs

"$NODE" tests/streaming.test.mjs

"$NODE" tests/manual-notes.test.mjs
