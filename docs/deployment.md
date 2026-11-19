# 生产部署

[返回 README](../README.md)

运行环境由 Web、Worker 和 PostgreSQL 18 组成。两类应用进程必须使用相同数据库、认证密钥和加密密钥。Web 处理页面、API 与支付回调，Worker 处理采购、兑换、通知、汇率和定期清理。

## 1. 配置环境

从仓库根目录复制配置；已有 `.env` 时直接编辑，不覆盖：

```sh
cp .env.example .env
chmod 600 .env
```

正式环境至少填写：

| 变量                 | 配置要求                                                                      |
| -------------------- | ----------------------------------------------------------------------------- |
| `APP_MODE`           | `live`                                                                        |
| `APP_URL`            | 本站的 HTTPS origin，不带路径，如 `https://store.example.com`；不是供货站域名 |
| `ADMIN_EMAIL`        | 初始所有者邮箱                                                                |
| `ENCRYPTION_KEY`     | 独立的 32 字节十六进制密钥，用于加密业务数据                                  |
| `BETTER_AUTH_SECRET` | 另一份独立随机密钥，用于认证                                                  |
| `OPAQUE_SERVER_KEY`  | OPAQUE server setup；也可使用 `OPAQUE_SERVER_KEY_FILE`                        |
| `POSTGRES_PASSWORD`  | 使用内置数据库时必填，建议用随机十六进制值避免连接串转义问题                  |
| `DATABASE_URL`       | 外部数据库或直接运行 Bun 时必填；使用内置数据库时删除示例中的本地连接串       |
| `PORT`               | 仅 `compose.prod.yaml` 使用：**宿主机**映射端口，默认 `3000`。容器内固定监听 `3000`，改这里不会改容器内端口 |
| `BIND_ADDRESS`       | 仅 `compose.prod.yaml` 使用：宿主机监听地址，默认 `127.0.0.1`（前面有网关时保持默认，直接对外才改） |

**关于 `ENCRYPTION_KEY` 的一个易错点**：`APP_MODE=live` 且未设置 `ENCRYPTION_KEY` 时会直接启动失败（不会自生成），这是有意的。只有在 demo/开发模式下、且未设置该变量时，系统才会把密钥生成到 `.data/encryption.key`。**所以「密钥在哪里」要先看运行模式**：生产在 `.env`，开发可能在 `.data/encryption.key`。备份时必须确认备份的是**正在生效的那一把**，并且与数据库 dump 分开存放。


分别执行两次以下命令，为 `ENCRYPTION_KEY` 和 `BETTER_AUTH_SECRET` 生成不同的值；数据库密码另行生成：

```sh
openssl rand -hex 32
```

生成一次 OPAQUE setup 并保存到配置：

```sh
bunx @serenity-kit/opaque@0.9.0 create-server-setup
```

将上述密钥与数据库分别安全备份，重启、更新镜像时保留原值。已有数据时更换加密密钥会导致旧数据无法解密，更换 OPAQUE setup 会影响已有密码登录。

使用 `OPAQUE_SERVER_KEY_FILE` 时，需自行只读挂载文件到 Web 和 Worker，并确保容器内 `bun` 用户（UID 1000）可读。默认 Compose 不会自动挂载宿主机路径；直接使用 `OPAQUE_SERVER_KEY` 可省去文件挂载。

**内置数据库特别说明**：`.env.example` 的 `DATABASE_URL` 指向宿主机开发端口。用 `compose.prod.yaml` 时删除该行，Compose 才会生成指向 `postgres:5432` 的连接串；同时将 `APP_MODE=demo` 改为 `live`。

## 2. 从源码部署

在仓库根目录运行：

```sh
docker compose -f compose.prod.yaml config --quiet
docker compose -f compose.prod.yaml build
docker compose -f compose.prod.yaml up -d postgres
docker compose -f compose.prod.yaml run --rm web db:init
docker compose -f compose.prod.yaml run --rm web db:seed
docker compose -f compose.prod.yaml run --rm web db:verify
```

`db:init` 仅用于空 schema。已有数据库按 [数据库维护](database.md) 更新，不重复初始化。`db:seed` 补齐默认记录，不覆盖现有售价。

### 创建初始管理员

在服务器上创建仅自己可读的文件，写入 16–128 字符的初始密码。把密码保存到密码管理器；不要把它写进命令行、Git 或 Release。

也可在下列路径尚不存在时生成随机初始密码：

```sh
umask 077
openssl rand -hex 24 > .data-bootstrap-admin.txt
```

通过标准输入复制到容器内的临时文件，避免宿主机文件所有权与容器 UID 不一致：

```sh
docker compose -f compose.prod.yaml run --rm -T web sh -c \
  'umask 077; cat > /tmp/bootstrap-admin.txt; BOOTSTRAP_PASSWORD_FILE=/tmp/bootstrap-admin.txt bun scripts/bootstrap-admin.ts' \
  < .data-bootstrap-admin.txt
```

初始化不会重置已有所有者。登录并完成邮件、Passkey / TOTP 等账号安全配置后删除临时密码文件。

### 启动服务

```sh
docker compose -f compose.prod.yaml up -d web worker
docker compose -f compose.prod.yaml ps
docker compose -f compose.prod.yaml logs --tail=100 web worker
```

默认 Web 仅发布在 `127.0.0.1:3000`，由 HTTPS 网关转发访问。容器以非 root 用户运行，根文件系统只读，临时文件和 Next.js 缓存使用 tmpfs。数据库数据保存在 `postgres-data` 卷中。

## 使用 GHCR 发布镜像

镜像地址为 `ghcr.io/getcodex-plus/store`，由 GitHub Release 发布后构建。首次发布前没有可供拉取的镜像。

在 `.env` 中设置 `GETCODEX_IMAGE` 为已经发布的具体版本标签或镜像摘要；标签规则见 [版本发布](releasing.md)。生产更新优先固定版本，避免跟随可变的 `latest` 或 `prereleased`。

```sh
docker compose -f compose.prod.yaml -f compose.ghcr.yaml pull web worker
```

后续初始化、管理员创建和启动命令均使用相同的 `-f compose.prod.yaml -f compose.ghcr.yaml` 文件组合；启动使用 `up -d --no-build`。私有包需要先配置 GHCR 登录，公开包需由仓库维护者确认包的可见性。

预构建镜像中的 `NEXT_PUBLIC_GA_ID` 在构建时固定。需要自己设置 GA4 时，从源码构建并在构建、运行时设置同一个值；只修改运行时环境变量不会更新客户端代码。

## 外部数据库

`compose.external.yaml` 是独立文件，不与 `compose.prod.yaml` 叠加：

1. 在 `.env` 中配置 `APP_MODE=live`、完整 `DATABASE_URL` 及其他正式密钥。
2. 确认容器可访问数据库，数据库及应用 schema 已存在。
3. 将源码部署流程中的 `-f compose.prod.yaml` 换为 `-f compose.external.yaml`，跳过启动 `postgres`。

可叠加 `compose.ghcr.yaml` 使用发布镜像。外部数据库的访问控制、TLS、备份和高可用由数据库服务配置。

## 网关与 Traefik

网关负责 HTTPS、代理链信任和客户端 IP 的提取，转发前将 `X-Forwarded-For` **覆盖为单个客户端 IP**。应用的认证、风控和支付共用 Better Auth 的地址解析规则；多个逗号分隔地址不会被当成有效的客户端 IP。仅允许网关访问应用端口。

接入已有 Traefik 时，在 `.env` 中设置 `APP_DOMAIN`，按实际网关设置 `TRAEFIK_NETWORK`、`TRAEFIK_ENTRYPOINT` 和 `TRAEFIK_CERTRESOLVER`：

```sh
docker compose -f compose.prod.yaml -f compose.traefik.yaml up -d
```

Traefik 网络和证书解析器需提前配置。此叠加文件只添加路由、TLS 标签和网络连接；客户端 IP 的提取与请求头覆盖需在网关侧完成。也可同时叠加 `compose.ghcr.yaml`。

## 直接运行 Bun

安装 Bun 1.4.4+、Node.js 22.12+，准备独立数据库和完整正式 `.env`：

```sh
bun install --frozen-lockfile
bun run db:init
bun run db:seed
bun run db:verify
BOOTSTRAP_PASSWORD_FILE=/protected/path/bootstrap-admin.txt bun run admin:bootstrap
bun run build
```

分别使用进程管理器运行 `bun run start` 和 `bun run worker`，工作目录均为仓库根目录。`start` 默认监听 `127.0.0.1:3000`，通过 HTTPS 网关访问。设置自动重启与开机启动，并为 Worker 留足正常退出时间（Compose 使用 140 秒）。

## 站点和渠道配置

在 `/admin` 完成以下配置后再开放购买：

1. **支付与服务**：配置 Dujiao-Next 上游地址、API Key / Secret，AICDK、支付渠道和邮件服务。进货默认未启用。
2. **商品管理**：核对本地固定售价，绑定上游自动发卡 SKU，少量采购并确认库存入库；也可手动导入。
3. **网站设置**：选择启用的渠道，填写支持邮箱、账号操作指引、Turnstile 与可选客服参数。
4. **邀请返现**：核对等级、结算期和提现规则。可增删等级，至少保留一级；首级门槛为 0，后续门槛递增、比例不下降，比例上限为 9%。新规则只影响新订单。

密钥只写不回显；在途订单绑定服务配置版本，处理完成前应保留对应凭证。具体流程见 [订单与服务配置](orders-and-services.md) 和 [库存管理](inventory-batches.md)。

## 上线验证与运行维护

- 使用实际启用的渠道验证付款、重复回调、到账、兑换和退款；核对原订单、上游记录及钱包流水。
- 验证真实邮件、启用的人机验证和管理员登录；确认 Worker 持续工作、失败任务有人处理。
- 验证 HTTPS 地址、支付回调可达性、网关提供的客户端 IP，以及 Web / Worker 重启后的数据持久化。
- 定期备份数据库、服务配置和密钥，并在独立环境演练恢复。不要把 `docker compose down -v` 当作更新命令，它会删除数据库卷。
- 更新前记录镜像摘要并备份；按 [数据库维护](database.md) 执行增量 SQL，确保 Web 与 Worker 同步更新。回滚应用前先核对数据库兼容性。

容器健康检查访问 `/robots.txt`，只能证明 Web 可响应，不能替代数据库、Worker 或支付渠道监控。生产环境还需关注任务积压、异常订单和日志错误。
