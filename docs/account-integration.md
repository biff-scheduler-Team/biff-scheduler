# IFFDAY 账号接入

BIFF Scheduler 使用 IFFDAY OIDC 登录。网站继续运行在 `https://biff.lcandy.co`，原有访客排片和离线使用方式保留。账号中心为 `https://account.iff.day`。

## 登录与个人资料

BIFF 后端使用授权码流程和 PKCE S256，校验 state、nonce、issuer、audience 与 ID token 签名。客户端 ID 为 `biff-scheduler`，唯一生产回调地址为 `https://biff.lcandy.co/api/auth/callback`。账号提供方使用 `@better-auth/oauth-provider`，客户端使用 `oauth4webapi`。

BIFF cookie 为 `__Host-biff.session`，设置 Secure、HttpOnly、SameSite=Lax 和 Path=/。它只包含随机会话标识。OAuth token 在 BIFF D1 中加密存储，浏览器通过同源 `/api/account/*` 调用后端。后端通过 Cloudflare service binding 验证账号访问权限。整个登录过程不依赖第三方 cookie。

请求的 scope 为 `openid profile email offline_access profile:write`。修改名称、头像和简介需要 `profile:write`，同时验证 token 的资料 API audience。授权页说明这些改动会用于所有 IFFDAY 应用。邮箱仍用于登录；显示名称可以重复。

个人资料存放在账号系统的 `user_profile`，头像文件存放在 R2。浏览器将选取的图片裁成方形 JPEG，最长边 512px，最大 256 KiB。资料编辑带版本号，遇到其他页面已修改的情况会提示重新载入。

访问 token 有效期为 15 分钟。BIFF 会话有效期为七天，刷新 token 在后端轮换；并发刷新使用 D1 锁，并保留 30 秒的刷新响应重试窗口。退出 BIFF 删除其会话并撤销刷新 token。切换账号会重新进入 IFFDAY 登录流程。

## 本地数据与同步

首次登录可以选择将本机数据合并到账号。合并前保留本机副本。选片、场次、备注、已保存方案和现有 `biff.*` 偏好都参与同步，公开的影片资料仍从静态文件读取。

云端每个用户、每届影展有一份独立文档。目前届次为 `biff-2026`。写入使用 revision 校验，重复请求可由 operation ID 识别。客户端保存上次确认的版本，合并本机与云端修改；删除操作会保留，同一项内容的冲突需要选择保留哪个版本。

离线修改先保存在浏览器，恢复连接后继续同步。每个账号拥有独立缓存，账号切换不会将上一位用户的排片上传给下一位。会话过期时保留本机数据，重新登录后继续同步。普通数据备份只包含 `biff.*`，不包含账号缓存或登录凭据。

## Cloudflare 配置

Worker 为 `biff-scheduler`，D1 为 `biff-account-data`，`IFFDAY_API` 绑定 `iffday-account-api`。API 配置位于 `apps/api/wrangler.jsonc`。前端单独部署为 `biff-scheduler-web`，由 API 入口通过 `WEB` service binding 转发页面请求。前端 Worker 不绑定数据库或 OAuth 密钥。

生产需要两个 Worker secret：

- `OIDC_CLIENT_SECRET`：与账号系统登记的客户端凭据对应。
- `SESSION_SECRET`：至少 32 字符，用于加密后端会话中的 token。

自动构建沿用 `npm run build`，部署沿用 `npx wrangler deploy`。构建通过后，`postbuild` 生成 Wrangler 部署配置重定向，并仅在 Cloudflare 的 `main` 分支构建中执行生产迁移和前端 Worker 部署；随后原有部署命令发布 API。本地构建和预览分支跳过生产写入。手动发布使用 `npm run deploy`，同样先迁移再部署。发布顺序为账号 API、账号 Web，再发布 BIFF；新增 OAuth 表与资料字段通过增量迁移加入。

## 本地运行与 E2E

需要两个仓库的本地 checkout，并先安装各自依赖。`IFF-Day/account` 是私有仓库，需要已有读取权限。

```sh
npm ci
IFFDAY_ACCOUNT_PATH=/path/to/account npm run dev:account
```

启动脚本会生成本地随机密钥、应用本地迁移、登记测试客户端并构建两个项目。它保留已有 `.dev.vars`，配置不匹配时会停止并指出字段名。使用端口：BIFF 31028、账号 Web 5183、账号 API 8793、本地邮件 8035。服务注册目录独立于普通开发预览。

自动启动测试服务并运行浏览器测试：

```sh
IFFDAY_ACCOUNT_PATH=/path/to/account npm run test:e2e
```

针对已运行的上述服务：

```sh
npm run test:e2e
```

浏览器测试覆盖 Chromium 和移动 WebKit，检查授权、资料更新、原数据迁移、多设备同步、离线冲突、账号隔离和 token 刷新。`npm run build` 执行类型检查、lint、单元测试及生产构建。`npm run dev` 仍可用于只调试静态界面；账号功能需使用完整服务。

## 参考

- [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider)
- [oauth4webapi](https://github.com/panva/oauth4webapi)
- [Cloudflare service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)


## 前后端工作区与 Drizzle

项目使用 npm workspaces：`apps/web` 包含 Vite 前端、静态目录和前端单测；`apps/api` 包含 Hono、OIDC 服务端逻辑、Drizzle schema 与 D1 migrations；`packages/contracts` 只包含共享 Zod 契约和 JSON canonicalization。前后端禁止直接导入对方的源码。

公开域名、`/api` 路径及 OAuth 回调保持原样。`biff-scheduler` 作为 API 和公开入口，非 API 请求经内部 `WEB` 绑定交给独立的 `biff-scheduler-web`。这样可以分别构建、发布，同时沿用已存在的生产会话、密钥和 D1 数据。

D1 仍为 `biff-account-data`。Drizzle 使用 `drizzle-orm/d1`，schema 位于 `apps/api/src/db/schema.ts`。最初的 `0001_account.sql` 保留原文件名和内容，并作为 Drizzle snapshot 的起点；现有库无需重复建表或搬迁数据。后续修改 schema 后运行 `npm run db:generate`，审阅 SQL，再通过 Wrangler 应用迁移。不要对生产执行 `drizzle-kit push`。

```sh
npm ci
npm run build
npm run db:generate
npm run db:migrate
IFFDAY_ACCOUNT_PATH=/path/to/account npm run test:e2e

# 分别构建与部署
npm run build -w @biff/web
npm run build -w @biff/api
npm run deploy -w @biff/web
npm run deploy -w @biff/api
```

`npm run dev` 提供前端 Vite 热更新，适合访客功能开发。完整账号联调使用 `IFFDAY_ACCOUNT_PATH=/path/to/account npm run dev:account`，同时运行前端、BIFF API 和本地 IFFDAY。BIFF 本地密钥在 `apps/api/.dev.vars`，本地 D1 在 `apps/api/.wrangler/state`。迁移旧本地环境时，可将原根目录 `.dev.vars` 和 `.wrangler/state` 分别复制到以上位置；切勿上传到 Git。

`scripts/cloudflare-targets.json` 记录两个 Worker 的非敏感资源 ID。构建脚本先核对账号和 API Worker，再为前端部署设置它自己的 Wrangler 身份校验值；API 的最终部署仍由原生 Workers Builds 完成。若重新创建 Worker，需要更新该文件中的 ID。
