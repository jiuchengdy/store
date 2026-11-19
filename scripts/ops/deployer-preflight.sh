#!/usr/bin/env bash
# 部署者上线前体检：把「我们踩过的外部依赖坑」收敛成一条命令。
#
# 为什么需要它：本项目要提供给下游代理商自托管。我们在这套代码里踩到的坑
# （支持邮箱空着、ENCRYPTION_KEY 没设、GMPay 两个实现、品牌写死）会随部署数
# 复制 N 份——不收敛就会变成 N 份人工排查。
#
# 用法：scripts/ops/deployer-preflight.sh [--db-container <名>] [--psql-user <名>] [--db <库名>]
# 退出码：0=全部通过（或仅 WARN）  1=有 FAIL  2=连不上库，无法体检
set -u
DB_CONTAINER="${DB_CONTAINER:-store-db-1}"
DB_USER="${DB_USER:-getgpt}"
DB_NAME="${DB_NAME:-getgpt}"
DEPLOY="auto"   # bare | container | auto
while [ $# -gt 0 ]; do
  case "$1" in
    --db-container) DB_CONTAINER="$2"; shift 2 ;;
    --psql-user) DB_USER="$2"; shift 2 ;;
    --db) DB_NAME="$2"; shift 2 ;;
    --deploy) DEPLOY="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
# 部署形态决定「哪种密钥来源合法」，所以必须先判定形态，不能给跨形态的绿灯。
if [ "$DEPLOY" = "auto" ]; then
  if [ -f /.dockerenv ]; then DEPLOY="container"; else DEPLOY="bare"; fi
fi

FAIL=0
q() { docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null; }
pass() { printf '  PASS  %s\n' "$1"; }
warn() { printf '  WARN  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAIL=1; }
skip() { printf '  SKIP  %s\n' "$1"; }

# 0. 库能连上吗
if ! q "select 1" >/dev/null || [ -z "$(q 'select 1')" ]; then
  echo "无法连接数据库容器 $DB_CONTAINER（库 $DB_NAME，用户 $DB_USER）。"
  echo "本地开发常见原因：容器名不是 store-postgres-1；或库没起。"
  exit 2
fi

echo "== 1. 支持邮箱（空着 = 站点主动劝买家暂停购买）=="
MAIL=$(q "select coalesce(body->>'supportEmail','') from settings where id=1;")
if [ -n "$MAIL" ]; then pass "supportEmail = ${MAIL}（部署者自配置项，代理商须改成自己的）"
else fail "supportEmail 为空：页脚不渲染「联系支持」，/help/payment 显示「请先暂停购买」"; fi

echo "== 2. ENCRYPTION_KEY（丢了 = 历史卡密与提现账户永久解不开；形态：${DEPLOY}）=="
# 合法来源有四种：环境变量 / .env / ENCRYPTION_KEY_FILE / .data/encryption.key。
# 但「合法」取决于部署形态——容器化部署里 .data 不是合法来源（只读根文件系统写不进、
# 打进镜像则随容器重建消失，后果等同换过密钥）。只认其中一种来源会造成「合法部署永远
# 假 FAIL」，而不分形态则会给 .data 一个危险的 PASS：两种错都要避免。
KEY_SRC=""
KEY="${ENCRYPTION_KEY:-}"
if [ -n "$KEY" ]; then KEY_SRC="env"
elif [ -f .env ] && [ -n "$(grep -E '^ENCRYPTION_KEY=' .env | head -1 | cut -d= -f2-)" ]; then KEY_SRC="envfile"
elif [ -n "${ENCRYPTION_KEY_FILE:-}" ] && [ -s "${ENCRYPTION_KEY_FILE}" ]; then KEY_SRC="keyfile"
elif [ -s .data/encryption.key ]; then KEY_SRC="dotdata"
fi
case "$KEY_SRC" in
  env)     pass "密钥来源：环境变量 ENCRYPTION_KEY（容器化与裸机都合法）" ;;
  envfile) pass "密钥来源：.env（容器化与裸机都合法）"
           [ "$DEPLOY" = "container" ] && warn "容器化时请确认 .env 是以 env_file 注入，不是打进镜像层" ;;
  keyfile) pass "密钥来源：ENCRYPTION_KEY_FILE=${ENCRYPTION_KEY_FILE}"
           if [ "$DEPLOY" != "container" ]; then
             pass "  裸机/Bun 直跑：该路径只需随发布保留即可"
           elif [ ! -f /.dockerenv ]; then
             warn "  从宿主机无法判定容器内挂载情况：请进容器执行本脚本，或人工确认该路径是持久化卷"
           elif [ -r /proc/self/mountinfo ]; then
             if grep -qF "${ENCRYPTION_KEY_FILE}" /proc/self/mountinfo 2>/dev/null; then
               pass "  该路径在挂载卷内（容器重建后仍在）"
             else
               fail "  该路径不在任何挂载卷内：容器重建即丢失，那批密文全部报废"
             fi
           else
             warn "  无法自动确认该路径是否在持久化卷内，部署时请人工确认" ;
           fi ;;
  dotdata) if [ "$DEPLOY" = "container" ]; then
             fail "密钥来源只有 .data/encryption.key，容器化部署不可用：只读根文件系统写不进、打进镜像则随容器重建消失（等同换过密钥 → 那批密文全废）。请改用 ENCRYPTION_KEY 或挂载卷内的 ENCRYPTION_KEY_FILE"
           else
             pass "密钥来源：.data/encryption.key（裸机/Bun 直跑合法）" ;
           fi ;;
  *)       fail "没有任何密钥来源：live 模式会启动失败；demo 会临时生成一把，重启即旧密文全废" ;;
esac
[ -n "$KEY_SRC" ] && echo "        （必须另有独立离线第二份，且不得与数据库备份同机）"

echo "== 3. 支付/上游集成 =="
ACTIVE=$(q "select string_agg(provider,',' order by provider) from integrations where active;")
if [ -z "$ACTIVE" ]; then warn "没有任何启用中的集成（演示/纯库存站可接受，正式收款不可）"
else pass "启用中：$ACTIVE"; fi

GMP_URL=$(q "select coalesce(public->>'url','') from integrations where provider='gmpay' and active limit 1;")
if [ -z "$GMP_URL" ]; then skip "未启用 GMPay，跳过实现判定"
elif [ -x "$(dirname "$0")/probe-gmpay-impl.sh" ]; then
  echo "  正在判定 GMPay 实现（只读两条 GET）..."
  "$(dirname "$0")/probe-gmpay-impl.sh" "$GMP_URL" | sed 's/^/    /'
  case "${PIPESTATUS[0]}" in
    0) warn "GMPay = Epusdt：现有代码查的是 edge 的 order/query，回调会 404→503→不入账，必须先改接口" ;;
    1) pass "GMPay = gmpay-edge：现有查询路径正确" ;;
    *) warn "GMPay 实现无法判定（WAF/网络），不要据此改代码" ;;
  esac
else skip "probe-gmpay-impl.sh 不存在或不可执行"; fi

AICDK=$(q "select count(*) from integrations where provider='aicdk' and active;")
[ "$AICDK" = "1" ] && pass "AICDK 已启用（注意：无公开文档，幂等/留存必须按附录 §8 实测）" \
                    || skip "AICDK 未启用（纯卡密库存模式）"

echo "== 4. 品牌残留（代理商自托管场景）=="
if command -v grep >/dev/null && [ -d src ]; then
  HITS=$(grep -rn 'GetCodex' src --include=*.ts --include=*.tsx 2>/dev/null | grep -vc '\.test\.' || true)
  if [ "${HITS:-0}" -gt 0 ]; then
    warn "src 下仍有 ${HITS} 处 GetCodex 字面量：代理商不改代码就顶着本仓库品牌卖货（见 docs/DEPLOYER-SETTINGS.md）"
  else pass "src 下无品牌字面量残留"; fi
else skip "不在仓库根目录，跳过品牌扫描"; fi

echo
if [ "$FAIL" -ne 0 ]; then echo "RESULT: FAILED — 存在必须修复项，不要转 live"; exit 1; fi
echo "RESULT: OK — 无 FAIL（WARN 项请人工判断）"
