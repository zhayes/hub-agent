#!/usr/bin/env bash
set -euo pipefail

# V1.0 验收入口：先跑确定性测试，再跑最小 CLI 闭环。
# M10 会在此扩展 TC-001~TC-005、TC-008~TC-018 的回归脚本。
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pnpm verify

HUB="$(mktemp -d)"
trap 'rm -rf "$HUB"' EXIT
export HUBAGENT_HOME="$HUB"

pnpm -s hubagent init --json >/dev/null
pnpm -s hubagent doctor --json >/dev/null
pnpm -s hubagent config --json >/dev/null
pnpm -s hubagent task list --json >/dev/null
pnpm -s hubagent approval list --json >/dev/null
pnpm -s hubagent gc --json >/dev/null

echo "acceptance-v1: OK"
