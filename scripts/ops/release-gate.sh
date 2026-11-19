#!/usr/bin/env bash
# 发布前四件门禁：串行测试 + db:verify + preflight 双向 + 迁移幂等。
#
# 为什么固定成一条命令：这四件单看都能跑，但「谁跑过、跑的是哪个 commit、用的是哪个库」
# 从来记不清楚——上一轮就出现过「326/0 全绿」其实只覆盖单测、e2e 早已红。
# 门禁必须自己打印 commit 与库名，输出整段贴进发布记录，才算有证据。
#
# 用法：
#   scripts/ops/release-gate.sh [--db-container <名>] [--psql-user <名>] [--db <库>]
#                              [--test-db <测试库>] [--skip-tests]
#   默认：容器 store-db-1、用户 getgpt、库 getgpt、测试库 getgpt_test。
#   迁移幂等性用一个临时库完成（getgpt_gate_<pid>），跑完 drop，不碰任何现有库。
#
# 退出码（见 docs/ops/exit-codes.md，0/1/2 全团队共用）：
#   0 = 四件全通过
#   1 = 有门禁项失败（打印是哪一件）
#   2 = 无法检查（连不上库 / 缺依赖）
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 2
export PATH="$HOME/.bun/bin:$PATH"

DB_CONTAINER="${DB_CONTAINER:-store-db-1}"
DB_USER="${DB_USER:-getgpt}"
DB_NAME="${DB_NAME:-getgpt}"
TEST_DB="${TEST_DB:-getgpt_test}"
SKIP_TESTS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --db-container) DB_CONTAINER="$2"; shift 2 ;;
    --psql-user) DB_USER="$2"; shift 2 ;;
    --db) DB_NAME="$2"; shift 2 ;;
    --test-db) TEST_DB="$2"; shift 2 ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

psql_admin() { docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -tAc "$1" 2>/dev/null; }
FAILED=""

echo "=============================================="
echo " 发布前四件门禁"
echo " commit: $(git rev-parse --short HEAD)  branch: $(git rev-parse --abbrev-ref HEAD)"
echo " 工作区: $(git status --porcelain | wc -l | tr -d ' ') 处未提交改动"
echo " 库: ${DB_NAME} / 测试库: ${TEST_DB} / 容器: ${DB_CONTAINER}"
echo " 时间: $(date '+%Y-%m-%d %H:%M %z')"
echo "=============================================="

if [ -z "$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc 'select 1' 2>/dev/null)" ]; then
  echo "无法连接数据库（容器 ${DB_CONTAINER} / 库 ${DB_NAME}）" >&2
  exit 2
fi

# ---- 1. 串行测试 ----
echo
echo "== 1/4 串行测试（--no-file-parallelism + 30s 超时）=="
echo "  （并行会因 auth_rate_limit 共用 schema 出假 403；OPAQUE 单测实测 5.5s，默认 5s 超时本身就会假红）"
if [ "$SKIP_TESTS" = "1" ]; then
  echo "  SKIP  按 --skip-tests 跳过（发布时不许跳）"
else
  OUT=$(TEST_DATABASE_URL="postgresql://getgpt@127.0.0.1:55439/${TEST_DB}" \
        bunx vitest run --no-file-parallelism --testTimeout=30000 2>&1)
  LINE=$(printf '%s\n' "$OUT" | grep -E '^ +Tests +' | tail -1)
  FILES=$(printf '%s\n' "$OUT" | grep -E '^ +Test Files +' | tail -1)
  printf '  %s\n  %s\n' "${FILES:-（未取到 Test Files 行）}" "${LINE:-（未取到 Tests 行）}"
  if printf '%s\n' "$LINE" | grep -q 'failed'; then
    FAILED="${FAILED} 串行测试有失败;"
  fi
  printf '%s\n' "$LINE" | grep -qE 'skipped' && echo "  （报告口径：passed 与 skipped 必须成对报，见 docs/ops/exit-codes.md）"
fi

# ---- 2. db:verify ----
echo
echo "== 2/4 db:verify（结构基线）=="
if V=$(bun run db:verify 2>&1 | tail -8); then
  printf '%s\n' "$V" | sed 's/^/  /'
  EXPECTED='columns: 335'
  printf '%s\n' "$V" | grep -q "$EXPECTED" || FAILED="${FAILED} db:verify 数字与基线不符;"
else
  printf '%s\n' "$V" | sed 's/^/  /'
  FAILED="${FAILED} db:verify 执行失败;"
fi

# ---- 3. preflight 双向（只看 §3.5 回调域名判据）----
echo
echo "== 3/4 preflight 双向（公网域名必须 PASS、私网必须 FAIL）=="
PF="scripts/ops/deployer-preflight.sh"
SEC_A=$(APP_MODE=demo APP_URL=https://example.com bash "$PF" 2>&1 | sed -n '/3.5/,/^== 4/p')
if printf '%s\n' "$SEC_A" | grep -q 'PASS  回调 host'; then
  echo "  正向（https://example.com）PASS ✔"
else
  echo "  正向（https://example.com）没有 PASS —— 判据失效"; FAILED="${FAILED} preflight 正向未 PASS;"
fi
SEC_B=$(APP_MODE=live APP_URL=https://192.168.0.1 bash "$PF" 2>&1 | sed -n '/3.5/,/^== 4/p')
if printf '%s\n' "$SEC_B" | grep -q 'FAIL  回调 host'; then
  echo "  反向（https://192.168.0.1，live）FAIL ✔"
else
  echo "  反向（私网 IP）没有 FAIL —— 判据失效"; FAILED="${FAILED} preflight 反向未 FAIL;"
fi

# ---- 4. 迁移幂等（临时库）----
echo
echo "== 4/4 迁移幂等（临时库 getgpt_gate_$$）=="
GATE_DB="getgpt_gate_$$"
cleanup() { psql_admin "drop database if exists ${GATE_DB};" >/dev/null 2>&1 || true; }
trap cleanup EXIT
if ! psql_admin "create database ${GATE_DB};" >/dev/null; then
  echo "  无法创建临时库 ${GATE_DB}"; exit 2
fi
GATE_URL="postgresql://getgpt@127.0.0.1:55439/${GATE_DB}"
M1=$(DATABASE_URL="$GATE_URL" bun run db:init 2>&1 | tail -1)
M2=$(DATABASE_URL="$GATE_URL" bun run db:migrate 2>&1 | tail -2)
M3=$(DATABASE_URL="$GATE_URL" bun run db:migrate 2>&1 | tail -1)
echo "  init:     ${M1}"
printf '%s\n' "$M2" | sed 's/^/  migrate1: /'
echo "  migrate2: ${M3}"
printf '%s\n' "$M3" | grep -q '0 pending' || FAILED="${FAILED} 迁移不幂等（第二次仍 pending）;"
printf '%s\n' "$M2" | grep -q 'Applied 0001' || FAILED="${FAILED} 迁移未应用 0001_baseline;"
CNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$GATE_DB" -tAc "select count(*) from schema_version;" 2>/dev/null)
echo "  schema_version 行数: ${CNT:-?}（应为 1）"
[ "$CNT" = "1" ] || FAILED="${FAILED} schema_version 行数异常;"

# ---- 汇总 ----
echo
echo "=============================================="
if [ -z "$FAILED" ]; then
  echo "RESULT: PASS — 四件全过（commit $(git rev-parse --short HEAD)）"
  echo "把本段输出整段贴进发布记录，不要只写「跑过了」。"
  exit 0
fi
echo "RESULT: FAILED —${FAILED}"
exit 1
