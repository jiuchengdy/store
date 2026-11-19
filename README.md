# GetCodex Plus Store

**可自托管的 ChatGPT 充值商城，连接上游采购、在线收款与自动兑换。**

作为 [getcodex.plus](https://getcodex.plus) 的下游站点，通过 Dujiao-Next 协议采购兑换码，由 AICDK 完成账号核验与兑换。运营者可以独立设置商品售价、管理库存和处理售后，买家可以游客下单或登录使用钱包。

[快速开始](#快速开始) · [生产部署](docs/deployment.md) · [使用文档](#使用文档) · [参与开发](CONTRIBUTING.md) · [版本发布](docs/releasing.md)

## 功能

- **采购与库存**：上游商品目录、SKU 映射、采购进度查询、加密卡密入库、批次管理和手动导入。
- **购买与支付**：账号核验、限时报价、游客购买、钱包抵扣及混合支付；支持 XorPay、GMPay 和易支付。
- **兑换与售后**：后台任务提交兑换、同步结果；支持更新账号会话、人工核对、符合条件的原单免费补充和退款处理。
- **营销与返现**：优惠码、带券链接、推广员专属码、可配置邀请等级、收益结算及提现审核。
- **账号与管理**：邮箱验证码、OPAQUE 密码、Passkey、TOTP、角色权限、业务审计和风控记录。
- **站点运营**：Resend、Sendflare 或 SMTP 邮件，Turnstile，SEO、可选 GA4 与 Tawk.to 客服。

充值套餐按固定售价、单次订单收款，不自动续扣。新订单不销售订阅差价升级。提现由管理员实际转账后登记；自动原路退款仅支持 XorPay，其他渠道需人工处理。

## 运行方式

```text
买家 → Web 商城 → 支付渠道
          │
          └── 数据库 ← Worker → Dujiao-Next（采购） / AICDK（兑换）
```

Web 和 Worker 是两个独立进程，连接同一数据库。进货和兑换由 Worker 主动轮询；支付通过验签后的渠道回调确认。可选的 AICDK 通知仅用于提前唤醒查询。

技术栈：Next.js 16 App Router、React 19、Ant Design 6、Bun、Prisma 7、PostgreSQL 18 和 Better Auth。需要持久数据库与常驻 Worker，不支持纯静态部署。

## 快速开始

准备 Bun **1.4.4+**、Node.js **22.12+** 和 Docker Compose。CI 与容器固定使用 Bun 1.4.4；已有 PostgreSQL 18 时可直接配置数据库连接。

```sh
git clone https://github.com/getcodex-plus/store.git
cd store
cp .env.example .env
bun install --frozen-lockfile
docker compose up -d db
bun run db:init
bun run db:seed
bun run db:verify
bun run dev
```

已有 `.env` 时保留原文件并检查配置。默认开发数据库仅监听 `127.0.0.1:55439`；`db:init` 要求已有的空 schema，不会清空旧库。

另开终端启动后台任务：

```sh
bun run worker
```

访问 **<http://localhost:3000>**，后台为 **<http://localhost:3000/admin>**。访问地址需与 `.env` 中的 `APP_URL` 一致。

默认 `APP_MODE=demo` 仅允许本地访问：模拟支付和兑换，不发送真实邮件，验证码显示在页面。使用 `ADMIN_EMAIL` 对应邮箱登录可体验后台。自动生成的演示密钥保存在 `.data/`。

## 部署到生产环境

[生产部署指南](docs/deployment.md) 包含 Docker、本机进程部署、环境变量、初始管理员和网关接入。日常运维（备份、恢复演练、数据库变更、回滚、事故处置）见 [运维手册](docs/ops-runbook.md)。

| 部署文件                                         | 用途                                            |
| ------------------------------------------------ | ----------------------------------------------- |
| [`compose.yaml`](compose.yaml)                   | 本地开发数据库                                  |
| [`compose.prod.yaml`](compose.prod.yaml)         | Web、Worker 与带密码的生产数据库                |
| [`compose.ghcr.yaml`](compose.ghcr.yaml)         | 叠加使用 `ghcr.io/getcodex-plus/store` 发布镜像 |
| [`compose.external.yaml`](compose.external.yaml) | 使用外部数据库，独立运行                        |
| [`compose.traefik.yaml`](compose.traefik.yaml)   | 叠加接入已有 Traefik 网关                       |

首次镜像发布前从源码构建。生产环境需设置 `APP_MODE=live`、本站 HTTPS 地址和独立密钥，完成管理员初始化及真实渠道联调。网关负责解析代理链，并向应用提供单个客户端 IP。

## 使用文档

| 文档                                                  | 内容                                               |
| ----------------------------------------------------- | -------------------------------------------------- |
| [订单与服务配置](docs/orders-and-services.md)         | 购买、优惠码、兑换、免费补充、退款、支付与邮件接入 |
| [兑换码与导入批次](docs/inventory-batches.md)         | 上游采购、SKU 映射、批次、换码与库存规则           |
| [邀请返现与提现](docs/invitations-and-withdrawals.md) | 邀请等级、推广员优惠码、结算及打款登记             |
| [风控](docs/risk-control.md)                          | 风控规则与操作说明                                 |
| [SEO 与统计](docs/growth-and-seo.md)                  | 搜索收录、站点验证与 GA4                           |
| [数据库维护](docs/database.md)                        | 初始化、结构校验与存量数据库更新                   |
| [开发与测试](docs/development.md)                     | 目录结构、常用命令与独立测试数据库                 |
| [运维手册](docs/ops-runbook.md)                       | 部署更新、数据库变更顺序、备份与恢复演练、事故处置 |
| [客服剧本](docs/support-playbook.md)                  | 买家问题定性依据、回复话术与升级条件               |
| [上线阻塞清单](docs/GO-LIVE-BLOCKERS.md)              | 上线前必须完成项、负责人与验收判据                 |
| [版本发布](docs/releasing.md)                         | GitHub 简介、发布检查、Release 与 GHCR 镜像        |

## 参与和反馈

提交问题或改动前请阅读 [贡献指南](CONTRIBUTING.md)。安全问题按 [安全说明](SECURITY.md) 私下报告。

历史验收见 [功能验收记录](docs/release-acceptance.md) 和 [数据库部署验收](docs/postgres-deployment-acceptance.md)，结果仅适用于各记录注明的日期、版本与范围。当前版本以重新运行的检查和目标环境联调为准。

仓库目前尚未声明开源许可证；公开源码不等于授予使用、修改或再分发许可。正式以开源项目发布前需补充许可证。
