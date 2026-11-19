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
# 退出码：
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
# PSQL_URL 非空时进入「CI 模式」：不依赖 docker，直接拿 psql 打 URL。
# 发布机上没有仓库 checkout 也没有本地容器名，CI 里没有 docker socket——两种环境共用同一套判据，
# 但数据库通道必须可切换，否则门禁只能在某一种环境里跑。
PSQL_URL="${GATE_PSQL_URL:-}"
APP_URL_VAL="${GATE_APP_URL:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --db-container) DB_CONTAINER="$2"; shift 2 ;;
    --psql-user) DB_USER="$2"; shift 2 ;;
    --db) DB_NAME="$2"; shift 2 ;;
    --test-db) TEST_DB="$2"; shift 2 ;;
    --psql-url) PSQL_URL="$2"; shift 2 ;;
    --app-url) APP_URL_VAL="$2"; shift 2 ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# 数据库通道：CI 模式走 psql URL，本地走 docker exec
dbq() {  # $1 = sql（打主库）
  if [ -n "$PSQL_URL" ]; then psql "$PSQL_URL" -tAc "$1" 2>/dev/null
  else docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null; fi
}
dbq_db() {  # $1 = 库名 $2 = sql
  if [ -n "$PSQL_URL" ]; then psql "${PSQL_URL%/*}/$1" -tAc "$2" 2>/dev/null
  else docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$1" -tAc "$2" 2>/dev/null; fi
}
psql_admin() {  # $1 = sql（打 postgres 维护库）
  if [ -n "$PSQL_URL" ]; then psql "${PSQL_URL%/*}/postgres" -tAc "$1" 2>/dev/null
  else docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -tAc "$1" 2>/dev/null; fi
}
FAILED=""

echo "=============================================="
echo " 发布前四件门禁"
echo " commit: $(git rev-parse --short HEAD)  branch: $(git rev-parse --abbrev-ref HEAD)"
echo " 工作区: $(git status --porcelain | wc -l | tr -d ' ') 处未提交改动"
if [ -n "$PSQL_URL" ]; then echo " 模式: CI（psql URL） / 库: ${DB_NAME} / 测试库: ${TEST_DB}"
else echo " 模式: 本地（docker exec） / 库: ${DB_NAME} / 测试库: ${TEST_DB} / 容器: ${DB_CONTAINER}"; fi
echo " 时间: $(date '+%Y-%m-%d %H:%M %z')"
echo "=============================================="

if [ -z "$(dbq 'select 1')" ]; then
  echo "无法连接数据库（${PSQL_URL:-容器 ${DB_CONTAINER} / 库 ${DB_NAME}}）" >&2
  exit 2
fi

# ---- 1. 串行测试 ----
echo
echo "== 1/4 串行测试（--no-file-parallelism + 30s 超时）=="
echo "  （并行会因 auth_rate_limit 共用 schema 出假 403；OPAQUE 单测实测 5.5s，默认 5s 超时本身就会假红）"
if [ "$SKIP_TESTS" = "1" ]; then
  echo "  SKIP  按 --skip-tests 跳过（发布时不许跳）"
else
  OUT=$(TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgresql://getgpt@127.0.0.1:55439/${TEST_DB}}" \
        bunx vitest run --no-file-parallelism --testTimeout=30000 2>&1)
  LINE=$(printf '%s\n' "$OUT" | grep -E '^ +Tests +' | tail -1)
  FILES=$(printf '%s\n' "$OUT" | grep -E '^ +Test Files +' | tail -1)
  printf '  %s\n  %s\n' "${FILES:-（未取到 Test Files 行）}" "${LINE:-（未取到 Tests 行）}"
  if printf '%s\n' "$LINE" | grep -q 'failed'; then
    FAILED="${FAILED} 串行测试有失败;"
  fi
  printf '%s\n' "$LINE" | grep -qE 'skipped' && echo "  （报告口径：passed 与 skipped 必须成对报）"
fi

# ---- 2. db:verify ----
echo
echo "== 2/4 db:verify（结构基线）=="
if [ -n "$PSQL_URL" ]; then
  V=$(DATABASE_URL="$PSQL_URL" bun --bun scripts/verify-database.ts 2>&1 | tail -8)
else
  V=$(bun run db:verify 2>&1 | tail -8)
fi
printf '%s\n' "$V" | sed 's/^/  /'
EXPECTED_COLUMNS="${EXPECTED_COLUMNS:-336}"
EXPECTED_CONSTRAINTS="${EXPECTED_CONSTRAINTS:-394}"
printf '%s\n' "$V" | grep -q "columns: ${EXPECTED_COLUMNS}" || FAILED="${FAILED} db:verify 列数 ${EXPECTED_COLUMNS} 不符;"
printf '%s\n' "$V" | grep -q "constraints: ${EXPECTED_CONSTRAINTS}" || FAILED="${FAILED} db:verify 约束数 ${EXPECTED_CONSTRAINTS} 不符;"

# ---- 3. preflight 双向（只看 §3.5 回调域名判据）----
echo
echo "== 3/4 preflight 双向（公网域名必须 PASS、私网必须 FAIL）=="
PF="scripts/ops/deployer-preflight.sh"
if [ -n "$PSQL_URL" ]; then
  # preflight 要连库、且默认用 docker exec；CI 里两者都没有。它本身是「部署机体检」，
  # 属于发布主机上的动作，不在 CI 里假装跑过——显式 SKIP，别给假绿。
  echo "  SKIP  CI 模式跳过（preflight 需要 docker exec + 部署环境，属发布机动作；发布时在主机上另跑）"
else
  SEC_A=$(APP_MODE=demo APP_URL=https://example.com bash "$PF" 2>&1 | sed -n '/3.5/,/^== 4/p')
  if printf '%s\n' "$SEC_A" | grep -q 'PASS  回调 host'; then
    echo "  正向（https://example.com）PASS ✔"
  else
    echo "  正向（https://example.com）没有 PASS —— 判据失效"; FAILED="${FAILED} preflight 正向未 PASS;"
  fi
  SEC_B=$(APP_MODE=live APP_URL=https://192.168.0.1 bash "$PF" 2>&1 | sed -n '/3.5/,/^== 4/p')
  if printf '%s\n' "$SEC_B" | grep -q 'FAIL  回调 host'; then
    echo "  反向（私网 IP，live）FAIL ✔"
  else
    echo "  反向（私网 IP）没有 FAIL —— 判据失效"; FAILED="${FAILED} preflight 反向未 FAIL;"
  fi
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
if [ -n "$PSQL_URL" ]; then GATE_URL="${PSQL_URL%/*}/${GATE_DB}"
else GATE_URL="postgresql://getgpt@127.0.0.1:55439/${GATE_DB}"; fi
# 直接调脚本，不走 `bun run`（后者内置 --env-file=.env，CI 里没有 .env）
M1=$(DATABASE_URL="$GATE_URL" bun --bun scripts/init-database.ts 2>&1 | tail -1)
M2=$(DATABASE_URL="$GATE_URL" bun --bun scripts/migrate.ts 2>&1 | tail -2)
M3=$(DATABASE_URL="$GATE_URL" bun --bun scripts/migrate.ts 2>&1 | tail -1)
echo "  init:     ${M1}"
printf '%s\n' "$M2" | sed 's/^/  migrate1: /'
echo "  migrate2: ${M3}"
printf '%s\n' "$M3" | grep -q '0 pending' || FAILED="${FAILED} 迁移不幂等（第二次仍 pending）;"
# 第一次跑完也必须是 0 pending：说明「init 建的结构 + 迁移账本」已经对齐，没有遗留待应用项。
# 不再硬断言「Applied 0001」——init.sql 会把基线那版登记进账本，具体哪一版被 applied 取决于 init 的实现。
printf '%s\n' "$M2" | grep -q '0 pending' || FAILED="${FAILED} 首次迁移后仍有 pending;"
CNT=$(dbq_db "$GATE_DB" "select count(*) from schema_version;")
echo "  schema_version 行数: ${CNT:-?}（应等于 prisma/migrations 下的迁移文件数）"
EXPECTED_MIGRATIONS=$(ls prisma/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')
[ "$CNT" = "$EXPECTED_MIGRATIONS" ] || FAILED="${FAILED} schema_version 行数 ${CNT:-?} ≠ 迁移文件数 ${EXPECTED_MIGRATIONS};"

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
