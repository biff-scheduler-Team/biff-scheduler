# 三环境规划:开发 / 测试(Staging) / 生产

> 现状核实(2026-10-13):`ci.yml` 里 push `main` 只跑 lint/typecheck/单测 + 事后 E2E,
> **没有部署步骤** —— 实际部署由 Cloudflare Workers Builds 在 push 后自动触发(`npm run build` 过了就上线)。
> 也就是说**你现在是"本地"直接对"生产"**,中间没有 staging。本文档补这一层,并规划移动端对应的三档构建。

---

## 1. 为什么需要 staging(不是为了"看起来正规")

三个具体场景,没有 staging 会直接出问题:

1. **数据库迁移验证**:你现在 16 个 Drizzle migration 直接 `db:migrate:remote` 怼生产。
   一旦哪次迁移写错(加了个有问题的索引、漏了 NOT NULL 默认值),没有回滚——
   D1 的 Time Travel 能恢复数据,但恢复不了"你已经在这份坏 schema 上面又写了新数据"这件事。
2. **OIDC 回调联调**:`apps/api/src/oauth.ts` 的登录链路依赖账号系统 `account.iff.day` 登记的回调地址。
   新功能动到登录/会话,只能在生产直接试——出错就是真实用户被影响。
3. **iOS App 审核前验收**:App Store / TestFlight 的包需要指向一个"不是你本地、但也不是生产"的后端,
   不然每次调试 iOS 构建都在读写生产数据。

---

## 2. 后端:Cloudflare Workers + D1 的三环境配置

### 2.1 现状(`apps/api/wrangler.jsonc`)

```jsonc
{
  "name": "biff-scheduler",
  "vars": { "APP_ENV": "production", "APP_ORIGIN": "https://biff.lcandy.co,...", "OIDC_CLIENT_ID": "biff-scheduler" },
  "d1_databases": [{ "binding": "DB", "database_name": "biff-account-data", "database_id": "67301f90-..." }]
}
```

只有一份顶层配置 = 只有生产这一档(本地走 `wrangler dev` 用 miniflare 本地 D1,不读这份云端配置)。

### 2.2 补一个 `env.staging` 块

wrangler 支持具名环境(`env.<name>`),部署时用 `wrangler deploy --env staging` 区分。新建一个独立的 D1
数据库和 Worker 名字——**不要复用生产的 database_id**,否则 staging 写的测试数据会污染生产:

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "biff-scheduler",
  "account_id": "62cbe67b545f2d12c986729ac7ffcee8",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-12",
  "compatibility_flags": ["nodejs_compat"],
  "triggers": { "crons": ["*/5 0-22 * * *", "0-30 23 * * *", "35-55/5 23 * * *"] },
  "vars": { /* 生产现有配置原样保留 */ },
  "services": [{ "binding": "WEB", "service": "biff-scheduler-web" }, { "binding": "IFFDAY_API", "service": "iffday-account-api" }],
  "d1_databases": [{ "binding": "DB", "database_name": "biff-account-data", "database_id": "67301f90-...", "migrations_dir": "migrations" }],
  "observability": { "enabled": true, "logs": { "enabled": true, "invocation_logs": false } },

  // ★ 新增:staging 环境,独立 Worker 名 + 独立数据库 + 独立 OIDC 回调域名
  "env": {
    "staging": {
      "name": "biff-scheduler-staging",
      "vars": {
        "APP_ENV": "staging",
        "APP_ORIGIN": "https://staging.biff.lcandy.co",
        "IFFDAY_ORIGIN": "https://account.iff.day",
        "OIDC_CLIENT_ID": "biff-scheduler-staging"
      },
      "services": [
        { "binding": "WEB", "service": "biff-scheduler-web-staging" },
        { "binding": "IFFDAY_API", "service": "iffday-account-api" }
      ],
      "d1_databases": [
        { "binding": "DB", "database_name": "biff-account-data-staging", "database_id": "<新建后填入>", "migrations_dir": "migrations" }
      ],
      "triggers": { "crons": [] } // staging 不需要真的每 5 分钟抓官网,省配额
    }
  }
}
```

`apps/web/wrangler.jsonc` 同理加一份 `env.staging`,Worker 名用 `biff-scheduler-web-staging`。

### 2.3 要做的账号系统登记

- 去 `account.iff.day` 的开发者后台新注册一个 OIDC client:`biff-scheduler-staging`,
  回调地址填 `https://staging.biff.lcandy.co/api/auth/callback`;
- 生成一份新的 `OIDC_CLIENT_SECRET` 与 `SESSION_SECRET`,用 `wrangler secret put <name> --env staging` 单独设置——
  **不要和生产共用密钥**,否则 staging 泄漏等于生产泄漏。

### 2.4 命令对照

| 操作 | 本地 | Staging | 生产 |
|---|---|---|---|
| 启动 | `npm run dev:api` | `wrangler dev --env staging`(需远端 D1 用 `--remote`) | — |
| 部署 | — | `wrangler deploy --env staging` | `wrangler deploy`(默认 env) |
| 迁移 | `npm run db:migrate`(本地 sqlite) | `wrangler d1 migrations apply biff-account-data-staging --remote --env staging` | `npm run db:migrate:remote` |

**迁移纪律**:新迁移文件永远先在 staging 跑一遍、确认接口正常,再跑生产——这是 staging 存在的核心价值,别图省事跳过。

---

## 3. 移动端:Expo/EAS 的三档 build profile

`apps/ios`(规划中,见 `docs/ios-app-architecture.md`)用 `eas.json` 定义三档,核心是
**三档各自一个 bundle identifier**,这样手机上能同时装三个互不覆盖的 App:

```json
{
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": { "bundleIdentifier": "co.lcandy.biff.dev" },
      "android": { "package": "co.lcandy.biff.dev" },
      "env": { "EXPO_PUBLIC_API_BASE_URL": "http://localhost:8787" }
    },
    "preview": {
      "distribution": "internal",
      "ios": { "bundleIdentifier": "co.lcandy.biff.staging" },
      "android": { "package": "co.lcandy.biff.staging" },
      "env": { "EXPO_PUBLIC_API_BASE_URL": "https://staging.biff.lcandy.co/api" }
    },
    "production": {
      "ios": { "bundleIdentifier": "co.lcandy.biff" },
      "android": { "package": "co.lcandy.biff" },
      "env": { "EXPO_PUBLIC_API_BASE_URL": "https://biff.lcandy.co/api" }
    }
  }
}
```

`app.config.ts` 读 `process.env.EXPO_PUBLIC_API_BASE_URL` 决定请求打到哪个后端,三档互不干扰。

- `development`:Expo Dev Client,真机/模拟器直接装,支持热重载,指向本地或 staging API;
- `preview`:内部分发(TestFlight 内测 / Google Play 内部测试轨道),**你和朋友验收用这个**,指向 staging 后端;
- `production`:指向生产 API,走正式提审(`eas submit`)。

---

## 4. CI/CD 触发规则(要改的点)

现状 `push main` 直接触发 Cloudflare Workers Builds 部署生产,这一步要拆开:

| 触发 | 动作 | 现状 |
|---|---|---|
| PR 提交 | lint + typecheck + 单测 + 受影响 E2E | ✅ 已有(`ci.yml`) |
| 合并到 `main` | 自动部署 **staging**(后端)+ EAS **preview** 构建(移动端) | ★ 需新增 |
| 打 tag(如 `v1.2.0`) | 手动确认后部署**生产** + `eas submit` 提审 | ★ 需新增 |

做法:在 Cloudflare Workers Builds 的分支部署配置里,把 `main` 分支绑定到 staging 环境部署
(而不是生产),生产部署改成基于 tag 的单独 GitHub Actions job(`wrangler deploy` 不带 `--env`,
需要 `workflow_dispatch` 或 `push: tags: ["v*"]` 触发,并在 job 里显式要求人工 approve——
GitHub Environments 的 "required reviewers" 刚好能做这件事,不用额外工具)。

---

## 5. "稳定数据库"具体指什么(不是换产品,是做好这四件事)

1. **迁移版本化 + 按环境独立 apply**——你已经在用 Drizzle migrations,只是现在只有一条生产通道,
   补上 staging 这条即可,不用换 ORM 或数据库产品;
2. **备份**——D1 自带 Time Travel,30 天内任意时间点可回滚(`wrangler d1 time-travel`),免运维,
   不需要你额外写备份脚本或买第三方备份服务;
3. **测试数据隔离**——staging 库用造假/脱敏数据,不要导入生产用户的真实账号数据去跑测试;
4. **生产变更前必须先过 staging**——同一份 `.sql` 迁移文件,staging 先跑通再上生产,
   不要「生产现场改」。

---

## 6. 实施顺序

1. 建 `biff-account-data-staging` D1 库 + `biff-scheduler-staging` / `biff-scheduler-web-staging` 两个 Worker;
2. 账号系统注册 `biff-scheduler-staging` OIDC client,配好回调域名;
3. `apps/api/wrangler.jsonc`、`apps/web/wrangler.jsonc` 各加 `env.staging` 块,`wrangler secret put --env staging` 配密钥;
4. 把现有 16 个迁移在 staging 跑一遍,确认接口行为与生产一致;
5. 调整 Cloudflare Workers Builds 的分支部署规则:`main` → staging,生产改走 tag 触发 + 人工 approve;
6. 建 `apps/ios` 时直接按 §3 的三档 `eas.json` 来,不要等上线前才补。
