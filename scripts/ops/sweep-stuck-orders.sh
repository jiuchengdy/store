#!/usr/bin/env bash
# 滞留单巡检：扫「processing 超过 N 分钟」的订单（上线首周强制执行，每 30 分钟一次）。
#
# 为什么需要它：用户已拍板「上线前不做支付通道真实联调」，首周靠人工盯单兜底。
# 兜底如果没有可执行的命令，就只是一句话——每个人都以为自己会记得去看，
# 结果没人看。所以把它做成脚本 + 退出码，可以挂 cron、也能被 CI/告警消费。
#
# 用法：
#   scripts/ops/sweep-stuck-orders.sh [--db-container <名>] [--psql-user <名>] [--db <库>] [--minutes <N>]
#   默认 --minutes 30（用户定的口径：processing 超 30 分钟即人工接管）。
#
# 退出码（见 docs/ops/exit-codes.md，0/1 全团队共用）：
#   0 = 没有滞留单
#   1 = 有滞留单，需要人工接管（会逐单打印，便于直接贴进工单）
#   2 = 无法检查（连不上库 / 参数错）
set -u
DB_CONTAINER="${DB_CONTAINER:-store-db-1}"
DB_USER="${DB_USER:-getgpt}"
DB_NAME="${DB_NAME:-getgpt}"
MINUTES=30
while [ $# -gt 0 ]; do
  case "$1" in
    --db-container) DB_CONTAINER="$2"; shift 2 ;;
    --psql-user) DB_USER="$2"; shift 2 ;;
    --db) DB_NAME="$2"; shift 2 ;;
    --minutes) MINUTES="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
case "$MINUTES" in ''|*[!0-9]*) echo "--minutes 必须是整数" >&2; exit 2 ;; esac

q() { docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null; }

if [ -z "$(q 'select 1')" ]; then
  echo "无法连接数据库（容器 ${DB_CONTAINER} / 库 ${DB_NAME} / 用户 ${DB_USER}）" >&2
  exit 2
fi

STUCK_SQL="select count(*) from orders where status='processing' and created_at < now() - interval '${MINUTES} minutes'"
STUCK=$(q "$STUCK_SQL")
if [ -z "$STUCK" ]; then
  echo "无法执行巡检查询（库 ${DB_NAME} 可能缺 orders 表）" >&2
  exit 2
fi

echo "== 滞留单巡检（processing 超过 ${MINUTES} 分钟）=="
echo "库 ${DB_NAME} / 阈值 ${MINUTES} 分钟 / 时间 $(date '+%Y-%m-%d %H:%M %z')"

if [ "$STUCK" = "0" ]; then
  echo "RESULT: OK — 无滞留单（exit 0）"
  exit 0
fi

echo
echo "滞留 ${STUCK} 单，逐单如下（可直接贴进工单）："
q "select id || ' | ' || channel || ' | 金额 ' || amount || ' | 创建 ' ||
          to_char(created_at, 'YYYY-MM-DD HH24:MI') || ' | 已滞留 ' ||
          floor(extract(epoch from (now() - created_at)) / 60)::int || ' 分钟 | payment_id ' ||
          coalesce(payment_id, '(空)') || ' | 履约 ' || coalesce(fulfillment_status, '(空)')
   from orders
   where status='processing' and created_at < now() - interval '${MINUTES} minutes'
   order by created_at" | sed 's/^/  /'

echo
echo "按渠道："
q "select '  ' || channel || ': ' || count(*) from orders
   where status='processing' and created_at < now() - interval '${MINUTES} minutes'
   group by channel order by count(*) desc"

echo
echo "处置（详见 docs/ops-runbook.md §7.1 / §7.3）："
echo "  1. 先看 Worker 是否存活、ops_heartbeat 是否新鲜。"
echo "  2. 看 job 的 lastError 定性：缺货 / 账号问题 / 上游故障。"
echo "  3. 20 分钟内自行恢复 → 记录；否则人工接管，2 小时内给买家明确答复。"
echo "  4. crypto 单如果是「钱到账但我们没入账」，按 §7.3 补入账前必须同时校验金额。"
echo "RESULT: ACTION REQUIRED — ${STUCK} 单滞留（exit 1）"
exit 1
