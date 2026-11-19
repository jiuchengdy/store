#!/usr/bin/env bash
# 判定 GMPay 商户域名背后是 Epusdt（自托管 Go）还是 gmpay-edge（Workers/Bun 网关）。
# 只读：两条 GET，不带密钥、不下单、不改任何东西。
#
# 用法：scripts/ops/probe-gmpay-impl.sh https://pay.example.com
# 退出码：0=Epusdt  1=gmpay-edge  2=无法判定（网络/域名错/被墙/WAF）
set -u
ORIGIN="${1:-}"
[ -z "$ORIGIN" ] && { echo "usage: $0 https://<GMPay 商户域名>" >&2; exit 2; }
ORIGIN="${ORIGIN%/}"

probe() {
  # 返回 "<http_code> <body 前 200 字符>"
  curl -sS --max-time 8 -o - -w '\n%{http_code}' "$1" 2>/dev/null | tail -c 400 | tr '\n' ' '
}

CS=$(probe "$ORIGIN/pay/check-status/nonexistent-probe")
OQ=$(probe "$ORIGIN/payments/gmpay/v1/order/query")
CS_CODE=$(printf '%s' "$CS" | awk '{print $NF}')
OQ_CODE=$(printf '%s' "$OQ" | awk '{print $NF}')

echo "check-status : $CS_CODE"
echo "order-query  : $OQ_CODE"

# Epusdt：/pay/check-status/* 存在（400 或 200 带 10008），/payments/gmpay/v1/order/query 不存在（404）
# edge  ：反过来
if [ "$CS_CODE" != "404" ] && [ "$CS_CODE" != "000" ] && [ "$OQ_CODE" = "404" ]; then
  echo "VERDICT: Epusdt (self-hosted). P0#0 必须改接口：查询走 /pay/check-status/{trade_id}，"
  echo "         且响应只有 {trade_id,status}，现有的 currency/amount/order_id 校验必须重写。"
  exit 0
fi
if [ "$OQ_CODE" != "404" ] && [ "$OQ_CODE" != "000" ] && [ "$CS_CODE" = "404" ]; then
  echo "VERDICT: gmpay-edge (Workers/Bun). 现有 order/query 调用路径正确，无需改接口。"
  exit 1
fi
echo "VERDICT: UNDETERMINED — 两个端点都没给出可判别的信号（WAF 拦截 / 域名错 / 网络不通）。"
echo "         把上面两行状态码发给维护者，不要据此改代码。"
exit 2
