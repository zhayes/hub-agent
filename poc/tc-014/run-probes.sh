#!/usr/bin/env bash
# TC-014 可执行版：沙箱「边界」与「误伤」双向验证
#
# 用法：
#   bash poc/tc-014/run-probes.sh
#
# 退出码：
#   0  全部符合预期
#   1  存在不符合预期的用例
#   2  前置条件缺失（srt 未安装等）—— 这本身是 fail-closed 的预期行为
#
# 注意（实测踩到）：srt 的位置参数是 **argv**，不是 shell 字符串。
#   srt "echo hi"   → 把整串当成一个可执行文件名 → rc=127（伪装成"被拦截"）
#   srt echo hi     → 正确
#   srt -c "echo hi"→ 等价 sh -c，本条脚本用这个形式
set -uo pipefail

SRT="${SRT:-srt}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tc014.XXXXXX")"
SETTINGS="$WORK/srt-settings.json"
LOG="$WORK/results.log"
PASS=0
FAIL=0
SKIP=0

say() { printf '%s\n' "$*"; }
hr() { printf -- '------------------------------------------------------------\n'; }

# ---------- 0. 前置条件 ----------
hr
say "== 环境 =="
say "os      : $(uname -s) $(uname -m)"
say "workdir : $WORK"

if ! command -v "$SRT" >/dev/null 2>&1; then
  say ""
  say "FATAL: 找不到 srt 命令。"
  say ""
  say "这不是 bug —— V1 采用 fail-closed：沙箱不可用时拒绝执行是设计行为。"
  say "安装：npm i -g @anthropic-ai/sandbox-runtime"
  say "Linux 还需要：bwrap / socat / ripgrep"
  exit 2
fi

say "srt     : $("$SRT" --version 2>/dev/null || echo unknown)"
if command -v bwrap >/dev/null 2>&1; then
  say "bwrap   : $(bwrap --version 2>/dev/null)"
else
  say "bwrap   : 未安装（Linux 必需；macOS 不需要）"
fi
command -v rg >/dev/null 2>&1 && say "ripgrep : $(rg --version 2>/dev/null | head -1)" || say "ripgrep : 未安装（srt 需要）"
say "node    : $(node --version 2>/dev/null || echo none)"
say "npm     : $(npm --version 2>/dev/null || echo none)"
say "git     : $(git --version 2>/dev/null || echo none)"

# ---------- 1. 生成沙箱配置 ----------
# srt 默认「读全开、写全禁」；denyRead 必须显式写，否则凭据可读。
# denyWrite 用绝对路径：相对路径按 srt 进程 cwd 解析，不是按命令里的 cd。
cat > "$SETTINGS" <<JSON
{
  "network": {
    "allowedDomains": ["registry.npmjs.org", "*.npmjs.org"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.kube", "~/.config/gh", "$WORK/secret"],
    "allowRead": [],
    "allowWrite": ["$WORK"],
    "denyWrite": ["$WORK/project/.env"]
  }
}
JSON
say "settings: $SETTINGS"

# ---------- 2. 准备夹具 ----------
mkdir -p "$WORK/project" "$WORK/secret" "$WORK/npm-cache"
printf 'canary\n' > "$WORK/secret/canary.txt"
printf 'SECRET=1\n' > "$WORK/project/.env"
printf 'export const add = (a, b) => a + b;\n' > "$WORK/project/math.js"
cat > "$WORK/project/math.test.js" <<'JS'
import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './math.js';
test('add', () => assert.equal(add(1, 2), 3));
JS
cat > "$WORK/project/package.json" <<'JSON'
{ "name": "tc014-project", "private": true, "type": "module" }
JSON
# 必须是真实仓库，srt 的 .git/hooks 强制拒绝才会生效（手工 mkdir 不算）
git -C "$WORK/project" init -q

# 重要：srt 的强制拒绝路径（.git/hooks、.git/config、.bashrc 等）是 **cwd 相对**的。
# 从仓库外调用 srt 时，这些保护不会生效（实测）。
# 生产上 AgentHost / Verifier 必须以 worktree 为 cwd 启动，否则静默失去这层保护。
CWD="$WORK/project"

# ---------- 3. 用例执行器 ----------
# run_case <id> <allow|deny> <描述> <命令字符串>
# deny 判定必须是「非零退出 + 有拒绝信号」；只有非零退出不算通过（可能是命令不存在）。
run_case() {
  local id="$1" expect="$2" desc="$3" cmd="$4"
  local out rc verdict detail

  out="$( cd "$CWD" && "$SRT" --settings "$SETTINGS" -c "$cmd" 2>&1 )"
  rc=$?
  detail=""

  if [ "$expect" = "allow" ]; then
    if [ "$rc" -eq 0 ]; then
      verdict="PASS"; PASS=$((PASS+1))
    else
      verdict="FAIL"; FAIL=$((FAIL+1))
      detail="（预期通过，实际 rc=${rc}）"
    fi
  else
    if [ "$rc" -eq 0 ]; then
      verdict="FAIL"; FAIL=$((FAIL+1))
      detail="（预期被拒，实际成功执行）"
    elif printf '%s' "$out" | grep -qiE 'operation not permitted|not permitted|eperm|blocked|denied|not allowed|403|connect tunnel failed'; then
      verdict="PASS"; PASS=$((PASS+1))
    else
      verdict="FAIL"; FAIL=$((FAIL+1))
      detail="（退出码非 0 但无拒绝信号 —— 很可能不是沙箱拦的，需人工确认）"
    fi
  fi

  printf '[%-4s] %-3s 期望=%-5s %s\n' "$verdict" "$id" "$expect" "$desc"
  [ -n "$detail" ] && printf '       %s\n' "$detail"
  {
    printf '%s | expect=%s | %s\n' "$id" "$expect" "$desc"
    printf '   rc=%s verdict=%s\n' "$rc" "$verdict"
    printf '   output: %s\n' "$(printf '%s' "$out" | head -3 | tr '\n' ' ')"
  } >> "$LOG"
}

# ---------- 4. 边界用例（必须被拒） ----------
hr
say "== A. 边界：必须被拒 =="

run_case B1 deny "读被 denyRead 的目录" \
  "cat '$WORK/secret/canary.txt'"

run_case B2 deny "写 .git/hooks（内置强制拒绝，相对 cwd）" \
  "echo pwned > .git/hooks/pre-commit && cat .git/hooks/pre-commit"

run_case B3 deny "写 worktree 之外的路径" \
  "echo pwned > '$HOME/tc014-escape.txt'"

run_case B4 deny "写被 denyWrite 覆盖的 .env" \
  "echo HACKED=1 >> '$WORK/project/.env'"

if command -v curl >/dev/null 2>&1; then
  run_case B5 deny "访问白名单外域名" "curl -sS -m 8 https://example.com"
else
  say "[SKIP] B5  curl 未安装"; SKIP=$((SKIP+1))
fi

if [ -d "$HOME/.ssh" ] && [ -n "$(ls -A "$HOME/.ssh" 2>/dev/null)" ]; then
  run_case B6 deny "读真实 ~/.ssh（非空）" "ls '$HOME/.ssh'"
else
  say "[SKIP] B6  ~/.ssh 不存在或为空（避免把 ENOENT 误判为拦截）"; SKIP=$((SKIP+1))
fi

# ---------- 5. 误伤用例（必须通过） ----------
hr
say "== B. 误伤：必须通过 =="

run_case P1 allow "写 worktree 内文件" \
  "echo ok > '$WORK/project/app.js' && cat '$WORK/project/app.js'"

run_case P2 allow "运行测试（子进程 + 读工作区）" \
  "cd '$WORK/project' && node --test"

run_case P3 allow "git init + commit（不写 .git/config）" \
  "cd '$WORK/project' && git add -A && git -c user.name=poc -c user.email=poc@local commit -q -m poc && git log --oneline | head -1"

run_case P4 allow "写 npm 缓存目录（依赖安装写侧）" \
  "mkdir -p '$WORK/npm-cache/x' && echo ok > '$WORK/npm-cache/x/y' && cat '$WORK/npm-cache/x/y'"

if command -v npm >/dev/null 2>&1; then
  run_case P5 allow "npm install（真实网络 + 写 node_modules）" \
    "cd '$WORK/project' && npm_config_cache='$WORK/npm-cache' npm install --no-audit --no-fund --no-save is-number"
else
  say "[SKIP] P5  npm 未安装"; SKIP=$((SKIP+1))
fi

# ---------- 6. 汇总 ----------
hr
say "== 汇总 =="
say "PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
say ""
if [ "$FAIL" -gt 0 ]; then
  say "判读指引："
  say "  · A 组 FAIL 且命令能执行 → 沙箱没生效，最危险。"
  say "  · A 组 FAIL 但 rc=127 → 调用形式错误（srt 需要 -c 或 argv），不是策略问题。"
  say "  · B 组 FAIL → 沙箱太紧：补 registry 白名单 / 缓存目录 / 本地端口。"
  say "  · 两组同时 FAIL → 先确认 srt 本身能跑一条 echo。"
fi
say "详细记录: $LOG"
say "工作目录: ${WORK}（保留用于复现，脚本不自动删除）"

if [ -f "$HOME/tc014-escape.txt" ]; then
  say ""
  say "注意：$HOME/tc014-escape.txt 存在 → B3 失败，沙箱未拦住越界写。已删除。"
  rm -f "$HOME/tc014-escape.txt"
fi

[ "$FAIL" -eq 0 ] || exit 1
exit 0
