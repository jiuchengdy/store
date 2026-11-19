#!/usr/bin/env bash
# 滞留单巡检：上线首周强制执行，每 30 分钟一次（用户拍板「不做支付通道联调」的兜底）。
#
# 为什么扫三类：它们对应三种完全不同的故障形态。只扫 processing 会**漏掉最该抓的那类**——
# GMPay 回调 503（P0-B）时订单永远停在 unpaid，本地没有任何「处理中」痕迹，扫 processing 一笔都看不到。
#   A 履约卡：status='processing' 超 N 分钟（回调已接收，卡在发货/上游）
#   B 疑似「付了但没入账」：status='unpaid' + payment_attempted + payment_url 非空，超 N 分钟
#     注意：B 里**混着正常放弃支付的买家**（拿到收银台地址但没付），所以必须到网关核对后定性
#   C 建单失败：status='unpaid' + payment_attempted + payment_url 为空，超 5 分钟
#     买家点了支付却没拿到收银台地址，当场卡住
#
# 用法：
#   scripts/ops/sweep-stuck-orders.sh [--db-container <名>] [--psql-user <名>] [--db <库>]
#                                     [--minutes <N>] [--ignore-unpaid]
#   默认 --minutes 30。--ignore-unpaid：B 类只打印、不计入退出码（稳定期用；首周别用）。
#
# 退出码（见 docs/ops/exit-codes.md，0/1 全团队共用）：
#   0 = 三类都没有滞留单（或只剩被 --ignore-unpaid 排除的 B）
#   1 = 有滞留单，需要人工接管/核对（逐单打印，可直接贴进工单）
#   2 = 无法检查（连不上库、库缺 orders 表、参数非法）
set -u
DB_CONTAINER="${DB_CONTAINER:-store-db-1}"
DB_USER="${DB_USER:-getgpt}"
DB_NAME="${DB_NAME:-getgpt}"
MINUTES=30
IGNORE_UNPAID=0
while [ $# -gt 0 ]; do
  case "$1" in
    --db-container) DB_CONTAINER="$2"; shift 2 ;;
    --psql-user) DB_USER="$2"; shift 2 ;;
    --db) DB_NAME="$2"; shift 2 ;;
    --minutes) MINUTES="$2"; shift 2 ;;
    --ignore-unpaid) IGNORE_UNPAID=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
case "$MINUTES" in ''|*[!0-9]*) echo "--minutes 必须是整数" >&2; exit 2 ;; esac

q() { docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null; }

if [ -z "$(q 'select 1')" ]; then
  echo "无法连接数据库（容器 ${DB_CONTAINER} / 库 ${DB_NAME} / 用户 ${DB_USER}）" >&2
  exit 2
fi

SQL_A="status='processing' and created_at < now() - interval '${MINUTES} minutes'"
SQL_B="status='unpaid' and payment_attempted and payment_url is not null and created_at < now() - interval '${MINUTES} minutes'"
SQL_C="status='unpaid' and payment_attempted and payment_url is null and created_at < now() - interval '5 minutes'"

echo "== 滞留单巡检（A processing>${MINUTES}min / B unpaid+已点支付+有地址>${MINUTES}min / C unpaid+无地址>5min）=="
echo "库 ${DB_NAME} / 时间 $(date '+%Y-%m-%d %H:%M %z')"

report() {
  # $1=标签 $2=WHERE 子句 $3=处置提示；计数通过全局变量返回
  local cnt rows
  cnt=$(q "select count(*) from orders where $2")
  if [ -z "$cnt" ]; then
    echo "无法执行巡检查询（库 ${DB_NAME} 可能缺 orders 表）" >&2
    exit 2
  fi
  echo
  echo "[$1] ${cnt} 单"
  if [ "$cnt" != "0" ]; then
    rows=$(q "select id || ' | ' || status || ' | ' || channel || ' | 金额 ' || amount ||
                 ' | 创建 ' || to_char(created_at, 'YYYY-MM-DD HH24:MI') || ' | 已滞留 ' ||
                 floor(extract(epoch from (now() - created_at)) / 60)::int || ' 分钟 | payment_id ' ||
                 coalesce(payment_id, '(空)') || ' | 履约 ' || coalesce(fulfillment_status, '(空)')
              from orders where $2 order by created_at")
    printf '%s\n' "$rows" | sed 's/^/  /'
    echo "  处置：$3"
  fi
  LAST_COUNT="$cnt"
}

report "A 履约卡" "$SQL_A" \
  "先看 Worker 存活与 ops_heartbeat，再看 job 的 lastError；20 分钟内自愈则记录，否则人工接管、2 小时内答复买家（runbook §7.1）"
A="$LAST_COUNT"
report "B 疑似付了但没入账（含放弃支付的正常单）" "$SQL_B" \
  "不要凭本地状态补单。逐个到网关管理端按 order_id 查真实状态（trade_id / status=2），确认已付再按 runbook §7.3 补入账，且必须同时校验金额"
B="$LAST_COUNT"
report "C 建单失败（点了支付没拿到收银台地址）" "$SQL_C" \
  "买家当场卡住：让其重开收银台（同一 requestKey 命中原订单）；同类大量出现说明支付渠道不通，按 runbook §7.4 查"
CC="$LAST_COUNT"

TOTAL=$((A + B + CC))
echo
echo "== 汇总：A ${A} / B ${B} / C ${CC} = ${TOTAL} 单 =="

if [ "$TOTAL" = "0" ]; then
  echo "RESULT: OK — 三类均无滞留单（exit 0）"
  exit 0
fi

if [ "$IGNORE_UNPAID" = "1" ]; then
  ACTION=$((A + CC))
  echo "（--ignore-unpaid：B 类 B=${B} 只打印，不计入退出码）"
else
  ACTION=$TOTAL
fi
if [ "$ACTION" = "0" ]; then
  echo "RESULT: OBSERVE — 只有 B 类待核对，未计入退出码（exit 0）"
  exit 0
fi
echo "RESULT: ACTION REQUIRED — ${ACTION} 单需处置（exit 1）"
echo "留痕：本行连同上方向单列表记进巡检记录；有单时贴进工单，不要只写「有几单卡了」。"
exit 1
