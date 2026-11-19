#!/usr/bin/env bash
# 滞留单巡检：上线首周强制执行，每 30 分钟一次（用户拍板「不做支付通道联调」的兜底）。
#
# 为什么扫三类：GMPay 回调被拒时订单**永远停在 unpaid**（services.ts:683 建单 unpaid、
# :765 点支付只置 payment_attempted、:824 回调被接受才 processing），只扫 processing
# 会显示 RESULT: OK 而把每一笔漏掉。
#   A 履约卡：status='processing' 超 N 分钟（回调已接收，卡在发货/上游）
#   B 疑似「付了但没入账」：status='unpaid' + payment_attempted + payment_url 非空，超 N 分钟
#   C 建单失败：status='unpaid' + payment_attempted + payment_url 为空，超 5 分钟
#
# 另加一类（不属滞留单，但同一张表留痕，值班人一眼看全）：
#   D 退款超时：refund_status in (processing,review) 且未完成、受理超 24 小时（内部 SLA）；
#     其中超 48 小时的必须**主动回信**（runbook §7.6）。退款 100% 人工后，这一步没人盯就没人做。
#
# B 类**不靠猜**：拿本地 paymentId（= EPUSDT 的 trade_id）调公开无签名的
#   GET /pay/check-status/{trade_id}
# 自动分流：2=已付(需补入账) / 1=未付(买家没付完，忽略) / 3=过期 / 4=占位未选链。
# 只有 paymentId 为空（建单响应丢失 / 10002 场景）才进人工队列。
#
# 用法：
#   scripts/ops/sweep-stuck-orders.sh [--db-container <名>] [--psql-user <名>] [--db <库>]
#                                     [--minutes <N>] [--ignore-unpaid]
#   默认 --minutes 30。
#   --ignore-unpaid：B 类只打印、不计入退出码。**有护栏**：P0#6（check-status）没进本仓库源码时
#   直接 rc=2 拒绝——否则等于把唯一能抓「crypto 全挂」的那类关掉，还显示一片祥和。
#
# 环境变量：GMPAY_BASE_URL 覆盖网关地址（默认取 DB 里 gmpay 集成的 url）。
#
# 退出码（见 docs/ops/exit-codes.md，0/1 全团队共用）：
#   0 = 无需处置的单
#   1 = 有单需处置/核对（逐单打印，可直接贴进工单）
#   2 = 无法检查（连不上库、缺 orders 表、参数非法、护栏拒绝）
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

# 护栏：P0#6 未进源码时不许开 --ignore-unpaid。判断依据是本仓库 payments.ts 里已有 check-status
# （镜像由同一提交构建）；以仓库为准，不去猜运行中容器的内容。
if [ "$IGNORE_UNPAID" = "1" ]; then
  if ! grep -q 'check-status' src/server/integrations/payments.ts 2>/dev/null; then
    echo "--ignore-unpaid 被拒绝：P0#6（GMPay check-status）尚未进入本仓库源码。" >&2
    echo "  此时 B 类是唯一能发现「钱付了但没入账」的一类，忽略它等于把兜底关掉。" >&2
    exit 2
  fi
fi

q() { docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null; }

if [ -z "$(q 'select 1')" ]; then
  echo "无法连接数据库（容器 ${DB_CONTAINER} / 库 ${DB_NAME} / 用户 ${DB_USER}）" >&2
  exit 2
fi

GMPAY_BASE="${GMPAY_BASE_URL:-$(q "select coalesce(public->>'url','') from integrations where provider='gmpay' limit 1")}"
GMPAY_BASE="${GMPAY_BASE%/}"

check_status() {   # $1=trade_id；查不到返回空串
  [ -z "$GMPAY_BASE" ] && { echo ""; return; }
  curl -s --max-time 8 "${GMPAY_BASE}/pay/check-status/$1" 2>/dev/null \
    | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1
}

SQL_A="status='processing' and created_at < now() - interval '${MINUTES} minutes'"
SQL_B="status='unpaid' and payment_attempted and payment_url is not null and created_at < now() - interval '${MINUTES} minutes'"
SQL_C="status='unpaid' and payment_attempted and payment_url is null and created_at < now() - interval '5 minutes'"
# D 退款时限（内部 SLA：24 小时打款 / 48 小时必须主动回信）。字段与约束见 §7.6。
# 计时用 refund_requested_at（受理时间），**不是** created_at——后者更早，会提前报警。
# status='failed' 是 DB 约束的要求；不带它，约束生效前的历史行可能被扫出来变成「永远核销不掉」的单，
# 所以不合规存量单独警告、不混进 D 的计数。
SQL_D="refund_status in ('processing','review') and refund_completed_at is null and status='failed'
       and refund_requested_at < now() - interval '24 hours'"
SQL_D48="refund_status in ('processing','review') and refund_completed_at is null and status='failed'
       and refund_requested_at < now() - interval '48 hours'"
SQL_LEGACY="refund_status in ('processing','review') and status <> 'failed'"

echo "== 滞留单巡检（A processing>${MINUTES}min / B unpaid+已点支付+有地址>${MINUTES}min / C unpaid+无地址>5min / D 退款超 24h）=="
echo "库 ${DB_NAME} / 时间 $(date '+%Y-%m-%d %H:%M %z') / 网关 ${GMPAY_BASE:-(未配置)}"

count_where() { q "select count(*) from orders where $1"; }
list_where() {
  q "select id || ' | ' || status || ' | ' || channel || ' | 金额 ' || amount || ' | 创建 ' ||
            to_char(created_at, 'YYYY-MM-DD HH24:MI') || ' | 已滞留 ' ||
            floor(extract(epoch from (now() - created_at)) / 60)::int || ' 分钟 | payment_id ' ||
            coalesce(payment_id, '(空)')
     from orders where $1 order by created_at"
}

A=$(count_where "$SQL_A")
[ -z "$A" ] && { echo "无法执行巡检查询（库 ${DB_NAME} 可能缺 orders 表）" >&2; exit 2; }
C=$(count_where "$SQL_C")
[ -z "$C" ] && { echo "无法执行巡检查询" >&2; exit 2; }

echo
echo "[A 履约卡] ${A} 单"
if [ "$A" != "0" ]; then
  list_where "$SQL_A" | sed 's/^/  /'
  echo "  处置：先看 Worker 存活与 ops_heartbeat，再看 job 的 lastError；20 分钟内自愈则记录，否则人工接管（runbook §7.1）"
fi

# ---- B 类：逐单查网关状态自动分流 ----
B_PAID=0; B_UNPAID=0; B_EXPIRED=0; B_PLACEHOLDER=0; B_UNKNOWN=0; B_NOPID=0
B_DETAIL_PAID=""; B_DETAIL_UNKNOWN=""; B_DETAIL_NOPID=""
B_ROWS=$(q "select id || '|' || coalesce(payment_id,'') from orders where $SQL_B order by created_at")
B_TOTAL=0
if [ -n "$B_ROWS" ]; then
  while IFS='|' read -r OID PID; do
    [ -z "$OID" ] && continue
    B_TOTAL=$((B_TOTAL + 1))
    if [ -z "$PID" ]; then
      B_NOPID=$((B_NOPID + 1))
      B_DETAIL_NOPID="${B_DETAIL_NOPID}  ${OID}（payment_id 为空，建单响应丢失）"$'\n'
      continue
    fi
    case "$(check_status "$PID")" in
      2) B_PAID=$((B_PAID + 1)); B_DETAIL_PAID="${B_DETAIL_PAID}  ${OID}（trade_id ${PID}）：网关 status=2 已付，需补入账"$'\n' ;;
      1) B_UNPAID=$((B_UNPAID + 1)) ;;
      3) B_EXPIRED=$((B_EXPIRED + 1)) ;;
      4) B_PLACEHOLDER=$((B_PLACEHOLDER + 1)) ;;
      *) B_UNKNOWN=$((B_UNKNOWN + 1)); B_DETAIL_UNKNOWN="${B_DETAIL_UNKNOWN}  ${OID}（trade_id ${PID}）：网关无有效响应，需人工核对"$'\n' ;;
    esac
  done <<EOF
$B_ROWS
EOF
fi

echo
echo "[B 疑似付了但没入账] ${B_TOTAL} 单（网关分流：已付 ${B_PAID} / 未付 ${B_UNPAID} / 过期 ${B_EXPIRED} / 占位未选链 ${B_PLACEHOLDER} / 未核实 ${B_UNKNOWN} / 无 trade_id ${B_NOPID}）"
if [ "$B_PAID" != "0" ]; then
  printf '%s' "$B_DETAIL_PAID" | sed 's/^/  /'
  echo "  处置：status=2 已付但本地未入账 → 按 runbook §7.3 补入账，必须先核金额"
fi
if [ "$B_UNKNOWN" != "0" ]; then
  printf '%s' "$B_DETAIL_UNKNOWN" | sed 's/^/  /'
  echo "  处置：查不到 → 先重试一次（可能是本机到网关的网络问题），仍查不到再人工核对"
fi
if [ "$B_NOPID" != "0" ]; then
  printf '%s' "$B_DETAIL_NOPID" | sed 's/^/  /'
  echo "  处置：payment_id 为空只能走网关管理端按 order_id 反查（admin 凭据不进应用/脚本，由所有者操作）"
fi
if [ "$B_UNPAID" != "0" ] || [ "$B_EXPIRED" != "0" ] || [ "$B_PLACEHOLDER" != "0" ]; then
  echo "  （未付/过期/占位 = 买家没付完，正常，不计入告警）"
fi

echo
echo "[C 建单失败] ${C} 单"
if [ "$C" != "0" ]; then
  list_where "$SQL_C" | sed 's/^/  /'
  echo "  处置：买家当场卡住，让其重开收银台（同一 requestKey 命中原订单）；大量出现说明渠道不通（runbook §7.4）"
fi

# ---- D 退款人工时限（24h 打款 / 48h 必须主动回信）----
D=$(count_where "$SQL_D")
[ -z "$D" ] && { echo "无法执行退款时限查询" >&2; exit 2; }
D48=$(count_where "$SQL_D48")
echo
echo "[D 退款超时，24 小时未打款] ${D} 单（其中超 48 小时未主动回信：${D48} 单）"
if [ "$D" != "0" ]; then
  q "select id || ' | 退款 ' || coalesce(refund_status,'-') || '/' || coalesce(refund_destination,'-') ||
            ' | 金额 ' || amount || ' | 受理 ' || to_char(refund_requested_at, 'YYYY-MM-DD HH24:MI') ||
            ' | 已 ' || floor(extract(epoch from (now() - refund_requested_at)) / 3600)::int || ' 小时' ||
            ' | 经办 ' || coalesce(refund_actor,'(空)') ||
            ' | 备注 ' || coalesce(nullif(trim(refund_resolution_note),''), '(空)')
     from orders where $SQL_D order by refund_requested_at" | sed 's/^/  /'
  echo "  处置：按 §7.6 完成人工打款并回填凭证（币种/数量/链/txid）；超过 48 小时的必须**主动回信**说明原因，不要等买家催"
fi
LEGACY=$(count_where "$SQL_LEGACY")
if [ -n "$LEGACY" ] && [ "$LEGACY" != "0" ]; then
  echo "  ⚠ 另有 ${LEGACY} 条退款状态与订单状态不一致的**历史存量**（约束生效前写入，D 类不报、也核销不掉）："
  q "select id || ' | 订单 ' || status || ' | 退款 ' || coalesce(refund_status,'-') || ' | 受理 ' ||
            coalesce(to_char(refund_requested_at, 'YYYY-MM-DD HH24:MI'), '(空)')
     from orders where $SQL_LEGACY order by refund_requested_at nulls last" | sed 's/^/    /'
  echo "    处置：逐个人工确认退款是否已实际完成，再改订单状态或清退款字段（不要批量改，历史对账会断）"
fi

# ---- 汇总与退出码 ----
ACTION=$((A + C + B_PAID + B_UNKNOWN + B_NOPID + D))
echo
echo "== 汇总：A ${A} / B 需处置 $((B_PAID + B_UNKNOWN + B_NOPID))（B 总 ${B_TOTAL}）/ C ${C} / D 退款超时 ${D}（含超 48h ${D48}）= ${ACTION} 单需处置 =="

if [ "$IGNORE_UNPAID" = "1" ]; then
  ACTION=$((A + C + D))
  echo "（UNPAID_IGNORED：--ignore-unpaid 生效，B 类不计入退出码）"
fi

if [ "$ACTION" = "0" ]; then
  echo "RESULT: OK — 无需要处置的滞留单（exit 0）"
  exit 0
fi
echo "RESULT: ACTION REQUIRED — ${ACTION} 单需处置（exit 1）"
echo "留痕：本行连同上方向单列表记进巡检记录；有单时贴进工单，不要只写「有几单卡了」。"
exit 1
