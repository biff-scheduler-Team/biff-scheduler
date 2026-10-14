# iOS App 方向 · 整体架构

> 结论先行:**后端不需要新增任何服务器,也不需要迁走。** 你现在这套 Cloudflare 部署就是 iOS App 的后端。
> 唯一必须先改的后端代码是 `apps/api/src/index.ts:244` 的 Origin 校验(见 §4)。

---

## 1. 后端部署在哪里

**留在 Cloudflare,一个都不动。** 三个已经在线的东西就是完整后端:

| 组件 | 现在是什么 | 部署形态 | 地址 |
|---|---|---|---|
| API | `apps/api` Hono + Drizzle | Cloudflare Worker `biff-scheduler` | `biff.lcandy.co/api/*` |
| Web / 静态数据 | `apps/web` Vite 产物 | Cloudflare Worker `biff-scheduler-web` | `biff.lcandy.co/*` |
| 数据库 | D1 `biff-account-data` | 托管 SQLite,16 个迁移 | Worker binding `DB` |
| 定时采集 | `collectTicketSnapshots` | Worker Cron Triggers | `*/5 0-22` + `08:00` 每分钟 |
| 身份 | OIDC 对接 | 外部服务(非自建) | `account.iff.day` |

关键点:**这里没有一台你要运维的服务器**,已经跑在 Cloudflare 边缘。iOS App 只是"第四个客户端"接进来而已。

Worker 的入口分流逻辑(`apps/api/src/worker.ts`)本来就已经把两条路分开:

```ts
export default {
  async scheduled(controller, env) { await collectTicketSnapshots(env.DB, controller.scheduledTime); },
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/api" || path.startsWith("/api/")) return app.fetch(request, env, ctx);
    return env.WEB.fetch(request);   // 非 /api 走 Web Worker
  },
};
```

所以 iOS 只需要认准一个 base URL:`https://biff.lcandy.co/api`。

---

## 2. 客户端层:三种入口

新增 iOS App 不替代 PWA,**三个并存**,共用同一套后端:

| 入口 | 技术 | 构建/分发 | 说明 |
|---|---|---|---|
| **iOS App**(新) | React Native + Expo | EAS Build → TestFlight → App Store | 唯一不可替代能力:推送 |
| 安卓 App(顺带) | 同一份 RN 代码 | EAS Build 直接出 APK / AAB | 增量成本接近零 |
| Web PWA(已有) | Vite + React | Cloudflare Workers | 继续用,不动 |

选 RN + Expo 而非 Flutter / 原生 Swift 的理由(基于当前代码结构):

- `conflict.ts` / `plans.ts` / `ics.ts` / `gv.ts` / `score.ts` / `util.ts` 是**纯函数、零 DOM 依赖** → 可直接 import,一行不改;
- `packages/contracts` 的接口类型与 zod schema → 直接复用,iOS 不用重写一份类型;
- `apps/api` 整个后端 → 完全不动;
- 需要重写的只有 UI 层(React Spectrum S2 是浏览器 DOM 专用、`style.css` 设计 token、`grid.ts` 甘特网格的指针交互要换成触摸手势)。

工作量分布:**90% 在 UI 层**,不在后端、也不在业务逻辑。

---

## 3. 目录:新客户端放哪

沿用现有 npm workspaces 约定,加一个 `apps/ios` 即可,与 `apps/web`、`apps/api` 平级:

```
├─ apps/
│  ├─ web/                 # Vite 前端(已有,不动)
│  ├─ api/                 # Hono API(已有,不动)
│  └─ ios/                 # ★ 新增:Expo / React Native
│     ├─ app/              # Expo Router 路由
│     ├─ src/              # 复用 @biff/contracts + 纯函数层
│     └─ app.json          # Expo 配置(bundleId / push / permissions)
├─ packages/
│  └─ contracts/           # 前后端共享类型 —— iOS 也 import 这个
└─ tools/                  # 离线 Python 管线(继续本机跑,不要搬进 Worker)
```

`package.json` 的 `workspaces` 已经是 `["apps/*", "packages/*"]`,加目录即可被识别,不用改根配置。

---

## 4. 必须先改的后端:`index.ts:244`(硬阻塞)

现状代码:

```ts
app.use("/api/*", async (c, next) => {
  const config = configuration(c.env);
  const origin = new URL(c.req.url).origin;
  if (!config.origins.includes(origin)) return c.json({ error: "INVALID_HOST" }, 403);
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("origin") !== origin)
    return c.json({ error: "FORBIDDEN_ORIGIN" }, 403);   // ★ 问题在这
  await next();
});
```

**为什么是阻塞**:React Native 的 `fetch` **不发 `Origin` 请求头**(`Origin` 是浏览器 CORS 机制的东西,原生运行时没有)。于是:

- 所有 `GET` → 正常(不受该分支影响);
- 所有 `POST` / `PUT` / `DELETE` → `origin` 为 `undefined` ≠ `origin` → **一律 403**。

受影响的写接口(从路由表实测):

```
POST   /api/account/import                      ← 本机数据首次导入云端
PUT    /api/account/sync/biff-2026              ← 排片同步(核心功能)
POST   /api/account/logout
POST   /api/stats/want-ping
POST   /api/stats/film-votes-ping
POST   /api/stats/screening-attendance-ping
POST   /api/stats/ticket-results-ping
POST   /api/stats/telemetry-ping
POST   /api/feedback · DELETE /api/feedback/:id
POST   /api/feedback/:id/reactions
POST   /api/screenings/:code/discussion(及删帖 / reaction)
```

**修法方向**(还没动手,先记方案):不要简单地把这一层删掉或改成"没有 Origin 就放行"——那等于把 CSRF 防护拆了。正确做法是给原生客户端一条**显式通道**,例如:

1. 请求带一个自定义头(如 `X-Biff-Client: ios/1.0`),后端识别为原生客户端 → 跳过 Origin 比对,改用该头做校验;
2. 原生客户端改用 **Bearer token** 而非 Cookie 会话(见 §5),令牌本身就是凭证,不再依赖 Origin 做 CSRF 防护;
3. 以上两者通常一起做:**原生走 Bearer,浏览器继续走 Cookie + Origin**,两条路互不影响。

改之前要先加测试(现有 `apps/api/tests/` 已有 25 个测试文件,含 `config.test.ts` / `rate-limit.test.ts`,按同样风格补一个 Origin 分支的单测)。

---

## 5. 登录:会话怎么给原生用

现有链路(`apps/api/src/oauth.ts` + `auth-callback.ts`):

```
/ GET  /api/auth/login       → 302 到 account.iff.day 授权页
  GET  /api/auth/callback    → 回调,seal 成 session cookie(HttpOnly)
  use  requireIdentity       → 之后所有 /api/account/* 依赖这个 cookie
```

Cookie 有个天然限制:**原生客户端不好用**。RN 里虽然能配 cookie jar,但 iOS 对跨域 WebView ↔ 原生共享 cookie 有一套限制,容易踩坑。

推荐做法:

- iOS 端用 `expo-auth-session`(底层 `ASWebAuthenticationSession`)走同一个 OIDC 流程;
- 回调拿到的会话,由后端**额外签发一个 Bearer token** 返回给原生,原生存进 `expo-secure-store`(iOS Keychain);
- 之后原生请求带 `Authorization: Bearer <token>`,后端 `requireIdentity` 中间件加一条"先查 Bearer、再查 Cookie"的分支。

好处:浏览器与原生共用同一套身份与权限,`resolveIdentity` 只多一个入参来源,不用维护两套账号体系。

---

## 6. 唯一需要新增的存储:推送 token

iOS 的核心价值就是推送(余票放票提醒)。这部分需要新增:

- **客户端**:`expo-notifications` 申请权限 → 拿 APNs device token(经 Expo Push Service 或直连 APNs);
- **后端**:新增一张表存 `user_id ↔ device_token ↔ 平台 ↔ 更新时间`,以及用户在哪几部片的票要看;
- **触发点**:现有 `collectTicketSnapshots` 每次写快照时,比较上一轮快照,若某场次从"无票/未开放"变为"有余票",且该场次在某个用户的关注列表里 → 推送。

这张表是 iOS 方向**唯一**要新增的数据结构,放 D1 即可(记得同时加一个 Drizzle migration,现有 16 个,编号接 `0017`)。KV 不适合做这个(不便按用户查询),不用考虑。

---

## 7. 部署与成本

| 项目 | 平台 | 成本 |
|---|---|---|
| 后端 Worker + D1 + Cron | Cloudflare | 现有免费额度,量级完全够 |
| iOS 构建 | EAS Build | 免费额度有限,超出需付费订阅 |
| App Store 上架 | Apple Developer Program | **$99 / 年**(硬开销) |
| Google Play(顺带做安卓) | Google | **$25 一次性** |
| 测试分发 | TestFlight | 免费(随开发者账号) |

**发布流程**:`eas build -p ios` → `eas submit` → TestFlight 内测 → 提审上架。

**要提前想清楚的风险**:现有数据来自抓取 `biff.kr` 官网页面,仓库里 `robots.txt` 禁止收录、定位为个人自用。上架 App Store 意味着这一层保护消失,且 App 里若直接展示抓来的官方内容,存在审核被拒与版权争议的可能。现状(Web 版)不受这条影响,**这是上 iOS 需要单独做的取舍判断,不是技术问题**。

---

## 8. 实施顺序建议

1. **先改后端 Origin 校验 + 补单测**(§4)——不改这个,iOS 什么都写不了;
2. 后端加 Bearer 会话分支(§5),让原生能独立登录;
3. 建 `apps/ios`(Expo),先只做只读:排期网格 + 余票查看,直接读现有 `/api/guest`、`/api/general` 与静态 JSON;
4. 接排片同步(`PUT /api/account/sync/biff-2026`),此时才验证 §4 的改动是否真的通了;
5. 最后做推送:建表 + `expo-notifications` + 快照差分触发;
6. PWA 全程保留,不删——它是没有 App 时的兜底入口。

---

## 9. D1 能撑多少用户?好不好查数据?(2026-10-12 补充核实)

### 9.1 真实容量(Cloudflare 官方数据,Workers Paid 档,$5/月起)

| 配额 | Free | Paid |
|---|---|---|
| 行读 / 月 | 500 万 / 天 | 250 亿 / 月(超出 $0.001 / 百万行) |
| 行写 / 月 | 10 万 / 天 | 5000 万 / 月(超出 $1 / 百万行) |
| 单库存储上限 | 500MB | **10GB(硬顶,不可调)** |
| 账户总存储 | 5GB | 1TB |
| 单库吞吐 | 单线程处理,写请求排队:1ms/查询 ≈ 1000 次/秒,100ms/查询 ≈ 10 次/秒 | 同左 |

**结论**:读多写少的正常使用模式(查余票、看排期、偶尔同步一次排片)下,配额对成千上万用户都绰绰有余。

### 9.2 真正的瓶颈在哪

不是"用户总数",是**单一时刻的并发写**。D1 每个数据库单线程处理查询,写入要排队。风险场景是"放票瞬间所有人同时点想看/签到",瞬时写请求堆积,排队队列满了会直接返回 `overloaded` 错误。

现状的 `*-ping` 类写接口(`want-ping` / `film-votes-ping` / `ticket-results-ping` / `telemetry-ping`)单次写入都很小(一行 upsert),离这个上限还很远;真到了量级很大的那天,解法是把瞬时爆发的计数类写入先合并到 KV / Durable Object,再定期批量落回 D1,不需要整体换库。10GB 单库硬顶也是设计上引导走"按租户/按场景拆多库",而不是一个库撑到底——对这个项目的体量基本用不到。

### 9.3 数据库好不好查

**2026 年已经不是问题**:

- **生产库**:Cloudflare 控制台自带 Studio(`D1 → 选中数据库 → Studio`),浏览器里直接有 SQL 编辑器 + 可视化表格浏览 / 改行,体验接近 phpMyAdmin;
- **本地开发库**:就是原生 sqlite 文件(`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`),TablePlus / DBeaver / DB Browser for SQLite 都能直接打开;
- **项目里已有的第三条路**:`/api/admin/overview`、`/api/admin/rows`、`/api/admin/trends`、`/api/admin/audit` 这几个管理端点,是按业务口径聚合好的统计量与分页明细,比临时手写 SQL 更贴合日常运营排查,不需要额外搭建。
