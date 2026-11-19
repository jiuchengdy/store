# 运维手册（Runbook）

面向：接手发布与运维的人。目标不是「把服务跑起来」，而是**上线后钱货不出事、出事有人知道、能查、能救**。

所有命令在仓库根目录、Docker 宿主机上执行。生产统一使用 `-f compose.prod.yaml`（可选叠加 `-f compose.ghcr.yaml` / `-f compose.traefik.yaml`）。

## 1. 事实基线（已实测，不要凭印象）

| 事实 | 证据 |
|---|---|
| 备份→恢复链路可用 | `pg_dump -Fc` 92 KB / `pg_restore` 0.4 秒 / `db:verify` 335 列·393 约束·85 索引·6 触发器·6 函数 全过 |
| `db:verify` 只量骨架，量不出数据 | 一份 `--schema-only` 的空壳 dump 照样 335/393/85/6/6 全过，所以演练必须另比行数 |
| `db:init` **只能跑在空库上** | 非空 schema 直接抛 `Database initialization requires an empty schema` |
| 仓库里没有 Prisma migrations | `prisma/migrations` 不存在；增量靠 `prisma/updates/*.sql` 手工执行，无版本账本 |
| `db:verify` 是**精确比对**，不是兼容检查 | 多加一列即报 `Unexpected columns: users.<col>` |
| Worker 没有健康检查 | `compose.prod.yaml` 中 `worker.healthcheck.disable: true` |
| Web 健康检查只探 `/robots.txt` | 只能证明 Web 可响应，证明不了数据库、Worker、支付渠道 |
| 发布镜像链路已跑通 | GitHub Actions `Docker` workflow 在 `v0.1.0` 上 success，多架构已推 GHCR |

## 2. 上线前检查

1. **镜像固定到摘要**，不要用 `latest`：
   ```sh
   GETCODEX_IMAGE=ghcr.io/getcodex-plus/store@sha256:<digest>
   ```
   摘要从 Release 的 Actions 摘要页或 `docker image inspect` 取，记进变更记录。
2. **密钥文件权限**：`.env` 与密钥备份 `chmod 600`，属主为部署用户。`ENCRYPTION_KEY` / `OPAQUE_SERVER_KEY` / `BETTER_AUTH_SECRET` 一旦更换，旧数据不可解密、旧密码不可登录——**换之前先确认能不能承受**。
3. **先备份再动任何东西**（第 5 节），并确认最近一次恢复演练是绿的。
4. 确认 `APP_MODE`、`APP_URL`、回调地址与实际域名一致；`APP_URL` 错会导致回调地址错，直接产生死单。
5. **客服入口必填**：后台 `/admin` → 网站设置 → `supportEmail`（可选 Tawk、账号操作指引链接）。这个字段为空时页脚不渲染「联系支持」，而 `Support.tsx` 的空态会写「支持联系方式尚未公布……请先暂停购买」——**空着上线等于站点主动劝买家别买**。转 live 前请求一次 `/help/payment`，正文必须出现真实邮箱或链接。

## 3. 部署与更新

```sh
# 更新（不要用 down -v，它会删掉数据库卷）
docker compose -f compose.prod.yaml -f compose.ghcr.yaml pull web worker
docker compose -f compose.prod.yaml -f compose.ghcr.yaml up -d --no-build
docker compose -f compose.prod.yaml ps
```

**顺序纪律**：Web 与 Worker 是两个容器、同时替换。更新窗口内可能出现「新 Web + 旧 Worker」并存，因此**任何表结构变更必须向后兼容**（见第 4 节 expand-contract）。

**部署顺序是死的一句话：先迁移库，再滚动部署镜像。** 反过来做，新代码查新列会直接 500，而**没有任何东西会拦住你**：

- Web 的健康检查探的是 `/robots.txt`（来自镜像的 `HEALTHCHECK`），它不碰业务表，所以**库没迁移时它照样绿**；
- Docker 不会因为容器 `unhealthy` 就重启它，`restart: unless-stopped` 管的是进程退出，不是健康状态；
- 编排里也没有任何组件去读健康状态（没有 autoheal，没有外部探针）。

结果就是：容器全 Up、页面开始报错，运维去查镜像、查网络、查数据库连接，唯独想不到是部署顺序。

**回滚**：把 `GETCODEX_IMAGE` 指回上一个摘要并 `up -d --no-build`。回滚前先确认数据库结构是否已被新版本改动——**先扩后缩**的两步式变更才允许直接回滚代码。

## 4. 数据库变更（当前唯一安全的做法）

现状：没有 migration 工具，`db:init` 拒绝非空库。所以按下面顺序，**四步一步都不能跳**：

1. **改** `prisma/schema.prisma`（只加不删、只放宽不收紧：加列、加表、加可空字段）。
2. **同步契约**，别手改：
   ```sh
   DATABASE_URL=... bun scripts/ops/gen-contract.ts          # 重写 prisma/database-contract.json
   DATABASE_URL=... bun scripts/ops/gen-contract.ts --check  # 只检查，stale 则退出 1
   ```
   `db:verify` 是精确比对，契约不同步部署门禁就会红，新人会误判成「迁移失败」去回滚——那才是真事故。已实测：干净的库上 `--check` 与仓库里的契约**逐字节一致**；给 `users` 加一列后立刻 `Contract is stale` + 退出 1。契约要和 SQL 放进同一个提交。
3. **执行**增量 SQL（放 `prisma/updates/`，文件名带序号与日期），在**备份之后**、在维护窗口内执行：
   ```sh
   docker exec -i <postgres-container> psql -U getgpt -d getgpt -v ON_ERROR_STOP=1 < prisma/updates/00X_xxx.sql
   ```
4. **验证**：
   ```sh
   docker compose -f compose.prod.yaml exec -T web db:verify
   ```

**删除/重命名列必须分两个版本**：本版本只新增并双写，下个版本（确认旧代码已全部下线）再删除。理由：Web 与 Worker 同时替换，中间必然有短暂的版本错位。

长期建议（未实施）：引入 `schema_version` 表或 Prisma migrate 基线，让「库到第几版」可查。在此之前，**手工记录每次执行的 SQL 文件与时间**。

## 5. 备份（三层，缺一层等于没备份）

脚本：`scripts/ops/backup-db.sh`（备份）、`scripts/ops/restore-drill.sh`（恢复演练）。
两者都跑在**宿主机**上，因为异地副本和恢复演练都需要宿主机 docker 权限；做成容器反而要额外挂 docker socket，风险更大。

### 第一层：每小时本地 dump

```sh
DB_CONTAINER=<postgres-container> BACKUP_DIR=/var/backups/getcodex \
RETENTION_DAYS=7 REMOTE=ops@192.168.0.1:/srv/store-backups \
  sh scripts/ops/backup-db.sh
```

`DB_CONTAINER` 默认是 `store-postgres-1`（生产 compose 服务名）。**本地开发库要显式传 `DB_CONTAINER=store-db-1`**，否则脚本直接以 `container ... is not running` 退出——不是脚本坏了，是容器名不同。

crontab：

```cron
17 * * * * cd /srv/store && DB_CONTAINER=store-postgres-1 BACKUP_DIR=/var/backups/getcodex REMOTE=ops@192.168.0.1:/srv/store-backups sh scripts/ops/backup-db.sh >> /var/log/getcodex-backup.log 2>&1
```

每次运行产出三个文件，缺一个都不算完整备份：`.dump`（数据）、`.dump.sha256`（校验和，**写的是相对路径**，搬到异地后仍可 `shasum -c`）、`.dump.counts`（9 张钱与人相关表的行数，供演练核对）。

脚本自带四道自检，任一不过即非零退出：容器在跑、dump 非空、`pg_restore --list` 的 TOC 条目 ≥ 50（实测 222 条）、行数 sidecar 写全。产物权限统一 `0600`、备份目录 `0700`（dump 里是 PII、口令哈希和加密后的提现账户）。

退出码：`0` 正常、`1` dump/自检失败、`2` 异地拷贝失败、**`3` 未配置 `REMOTE`（只在本机有备份）**。最后这条是刻意的：以前它以 0 退出，等于「备份只在这台机器上」这件事永远不会让任何人发现。确实只需要本机副本时，显式传 `ALLOW_LOCAL_ONLY=1`。

### 第二层：异地副本

由上面的 `REMOTE` 完成（rsync 到 Q 機，走 WG 内网）。异地目录同样要定期清理，别把备份机塞满。

### 第三层：每周恢复演练（唯一能证明备份有效的动作）

```sh
17 3 * * 0 cd /srv/store && DB_CONTAINER=store-postgres-1 \
DRILL_BASE_URL="postgresql://getgpt:<pw>@127.0.0.1:5432/__DB__" \
  sh scripts/ops/restore-drill.sh >> /var/log/getcodex-drill.log 2>&1
```

它做三件事，**三件全绿才算备份有效**：新建临时库 → `pg_restore --exit-on-error` → 跑 `db:verify` 比对结构 → **按 `.counts` 逐表比对行数** → 删掉临时库。没有 `.counts` 就直接以 `4` 退出：只证明结构回来、不证明数据在，不算通过。

两种失败路径都实测过，门禁不会无条件变绿：

```
# 空壳 dump（--schema-only，数据全丢，结构完好）
drill: MISMATCH users expected=3 restored=0
drill: FAILED: row counts differ beyond tolerance 0: users        → 退出码 1

# 截断的 dump
pg_restore: error: could not read from input file: end of file
drill: FAILED: pg_restore reported errors                          → 退出码 1
```

`DRILL_TOLERANCE`（默认 0）只给写入非常频繁的站点留余量；**默认值下差一行就 FAIL**。临时库无论成败都会删除，不留残留。

**首周看到 `expected=N restored=N-1` 先别慌**：先确认那一刻是不是正好有下单在写。`expected` 是 dump 之后几秒取的数，备份本身是事务快照，两者差一行属于正常竞态，重跑一次通常就对齐了。真正的坏备份不会只差一行。

若宿主机没装 bun，改用镜像里的验证器：设置 `APP_IMAGE=<镜像>@sha256:<digest>` 与 `DRILL_NETWORK=<compose 网络>`，`db:verify` 会在一次性容器里跑。

## 6. 监控与告警（现状：基本没有，必须补）

现在没有任何外部探活与告警。以下四项按优先级：

1. **Worker 业务心跳（最高优先）**。Worker 是唯一自动出货的进程，`healthcheck` 被显式关闭，它死了 `docker ps` 仍是 Up。判据用业务量而不是端口：**最后成功出货时间**与**积压订单数**。建议写入 `ops_heartbeat` 表（每分钟 upsert），外部探活读它；超过 15 分钟无心跳或积压 > 20 即告警。
2. **支付 sweeper 心跳**。XorPay 查询是只读 GET、不需密钥，可放心高频跑（10 分钟一次无副作用）。回调最多重试约 6.5 小时，错过就是死单——sweeper 的心跳比 Worker 的还关键。
3. **站点外部探活**。Web 确实有健康检查（镜像 `HEALTHCHECK` 探 `/robots.txt`，`docker ps` 会显示 healthy/unhealthy），但**没有任何东西消费这个状态**：Docker 不会因 `unhealthy` 重启容器，编排里也没有 autoheal，探的又是静态文件——数据库挂了、迁移没做，它照样绿。所以它只是装饰，真正的探活必须来自**另一台机器**（同一台机器上，机器死了自检也死了）。
4. **日志**。`compose.prod.yaml` 已设 `json-file` 10 MB × 3，滚动没问题；但要有人看，至少每周搜一次 `error` 与验签失败。

告警通道本身也要有人负责：**告警发到一个没人看的群，等于没有告警**。

## 7. 事故处置分支

### 7.1 订单停在「已支付」不出货

1. 看 Worker 是否存活、`ops_heartbeat` 是否新鲜（第 6 节）。
2. 看 job 的 `lastError` 定性：缺货 / 账号问题 / 上游故障。
3. 注意：出货 job **没有最大尝试次数上限**，上游永久性错误会以每 5 分钟节奏一直重试，永远不会进 `failed`，因此也不会进「需要人工协助」——**这类单只能靠心跳和积压数发现**。
4. 30 分钟仍拿不到码 → 人工接管，2 小时内给买家明确答复（客服剧本见 `docs/support-playbook.md`）。

### 7.2 上游已扣款但不出货（资金滞留）

Dujiao-Next 官方明确**已付款的采购单没有退款接口**，所以这是纯人工流程：

1. 在 `procurement` 记录里定位上游订单号（`downstream_order_no`，形如 `stock_<requestKey>`）。
2. 登录上游站点，用该订单号查单，截图留证（含时间、订单号、金额）。
3. 在对方站点提交退款/补发工单，把工单号回填到订单备注。
4. 钱退回后再对本地订单做人工退款或补发，**不要先给买家退款再等上游**，否则资金两头悬空。
5. 记入对账清单，月底核对这笔钱最终是否回来。

### 7.3 支付成功但系统显示未支付

XorPay 查询接口有六种状态：`success` / `payed` 都算已付（前者通知成功、后者通知失败），`new` / `expire` / `not_exist` 不动作，**`fee_error`（手续费扣除失败）必须人工，不许自动入账**。补入账前必须同时校验金额。

### 7.4 整站不可用

1. `docker compose ps` 看容器状态；2. `docker compose logs --tail 100 web worker`；3. 数据库是否可连（`pg_isready`）；4. 磁盘是否满（备份最容易撑爆磁盘）；5. 证书是否过期。

## 8. 例行检查

| 频率 | 动作 |
|---|---|
| 每天 | 看备份日志有无 `FAILED` / `OFFHOST=missing`；看积压订单数与异常订单 |
| 每周 | 恢复演练是否绿；`error` 日志抽检；磁盘与备份目录大小 |
| 每次发布 | 记录镜像摘要；发布前备份；发布后 `db:verify` + 冒烟下单（demo 模式） |
| 每月 | 密钥与配置备份校验；对账：渠道流水 / `payment_event` / 提现打款三张表 |

## 9. 已知缺口（不在本手册范围内，需代码改动）

- 无 migration 工具与版本账本（第 4 节是权宜之计）。
- 备份**未加密**：当前只靠 `0600` 与目录 `0700` 控制，异地机器是多 agent 共用。建议上线前加 age/gpg，私钥只留在恢复方。
- Worker / sweeper 无业务心跳实现。
- 出货 job 无最大尝试次数。
- 上游错误码未覆盖 `invalid_order_key` / `stock_unavailable`，缺货会被当故障无限重试。
- 无自动对账视图。
