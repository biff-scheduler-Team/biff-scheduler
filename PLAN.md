# BIFF 排片工具(BIFF Scheduler)— 项目活文档

> 定位:自用釜山电影节排片工具 —— 解析官方 Ticket Catalogue → 可视化选片排期 → 冲突检测 → 导出 .ics → 一键跳豆瓣。
> 栈:Cloudflare Workers(线上 = https://biff.lcandy.co,推 main 自动部署;2026-09-13 起是**两个 Worker** ——
> API `biff-scheduler` + 静态资源 `biff-scheduler-web`)+ React / Router / Spectrum S2 + Vite + TS
> + Tailwind v4(增量双轨)+ 静态 JSON + D1(**仅存账号片单**)。
> **本文档 = 当前状态 + 决策 + 待办 + 架构(活文档)。历史轮次记录已归档至 `docs/history/`,不要再往回写流水账。**
> 最后更新:2026-09-14(**排期数据更新提示** —— 顶栏「数据更新」+ changelog 产物,见 §0 首条);
> 更早 = 2026-09-14(**官方付印册子并入产物** —— 排期 830 场 / 32 厅 / 影片介绍页 / 票务规则);
> 更早 = 2026-09-14(**同场观影 & 场次讨论** —— 票务三态 / 实际行程 / 同场人数 / 场次讨论);
> 更早 = 2026-09-14(**修 `sessionFor` 刷新把健康会话打成 401**);
> 更早 = 2026-09-14(**建议反馈留言板 PR**);
> 更早 = 2026-09-14(**规范补两条:大改动走 PR + 大重构前打 checkpoint**);
> 更早 = 2026-09-14(**桌面分栏 + 账号一体 + 想看人数**);
> 更早 = 2026-09-13(**IFFDAY 账号体系 + 前后端分仓**);
> 更早 = 把「靠人记住的规范」改成「机器能挡的闸门」(CI / 钩子 / check:repo / api 单测 / TEST-MAP / legacy 计划 / Dependabot);
> 更早 = 规范新增「§9 与 AI 协作的约定」(需求怎么提 / AI 交什么);
> 更早 = 「在 Google 地图打开 ↗」贴住影院地名(去掉行尾靠右);
> 更早 = 排片表 / 时间线海报与评分 + 详情简介;
> 更早 = 豆瓣相关电影;
> 更早 = 导入支持 .ics + 已保存方案改横向;
> 更早 = 顺位撞车(逐层)+ 一键修复 · 保存方案 · 按方案导出;
> 更早 = 移动端极端适配 —— 窄屏改「单日纵向时间线」(见 §0 与 `docs/plans/PLAN-20260912002532.md`);
> 更早 = 页脚贡献者署名(两个贡献者的 GitHub 主页外链,`PLAN-20260912001500`);
> 更早 = 抢票信息接入(顶栏开票倒计时(北京时间 + 韩国时间)+ 抢票信息弹层 + 开票日历 `.ics`
> + 网格卡节目嘉宾章 + 详情弹层活动节目区 + 行程票价与总花费),见 §3 的 `festival-extras.json` 契约;
> 更早 = 部署口径修正(线上 = https://biff.lcandy.co,推 `main` 自动部署) / 分享图片(行程图) / 方案对比:同一部片只留一场 / 豆瓣官方 API / 拖动顺位 = N 套方案)。

---

## 0. 当前状态快照(2026-09-14)

**✅ 已完成(已部署,线上可访问)**
- **修「我的行程」顺位拖拽在页面滚动后判定错位(2026-09-14,`PLAN-20260914205901`,已推送)**:CI 全量 E2E
  连续红在 `e2e/react/desktop.spec.ts:4` —— 拖完 `biff.ranks.v1` **根本没写入**(`"undefined" is not valid JSON`)。
  根因:`AgendaPage.startDrag()` 拿 pointerdown 时刻捕获的**视口 rect** 去比后续的 `e.clientY`;拖拽中途页面
  一旦被滚动(拖到视口边缘的自动滚动 / 浏览器把目标行滚进视口 / Playwright 的 `scrollIntoViewIfNeeded`),
  两者就不再同源,阈值整体偏移、排序静默失效 —— **真实用户同样会踩到**。改为统一换算成「相对容器顶」的
  局部坐标,滚动量由 `paint()` 里现取的容器 rect 吸收。
  ⚠ 试过把测试改成手动鼠标手势来绕过,但行程页有 `window` + 内部列表**两层滚动容器**
  (探针实测 `scrollIntoViewIfNeeded` 只改内部容器:`scrollY` 仍为 0 而目标行从 728 移到 176;
  `window.scrollBy` 只改 window),滚动量没法稳定控制、反而更脆 —— 故保留 `dragTo`(它天然覆盖这条路径)。
  顺带稳定化 `review-schedule.spec.ts:60` 的 **flaky**:`page.clock.install({time})` 之后时钟**仍按真实时间
  流逝**,而该用例起点是 `23:59:59`(距午夜只剩 1 秒),页面加载慢过 1 秒 `todayIsoLocal()` 就已跨日 →
  mobile 默认日期漂到 10-11(10-11 也在 `dates` 里);改为 `install` 后立刻 `pauseAt` 冻结,跨午夜交给
  原本就有的 `fastForward(2000)`。
  证据:撤掉实现修复 → `1 failed`(与 CI run 34842131579 报错逐字一致);带修复 → `4 passed`;
  `review-schedule.spec`(两个 chromium 视口)`12 passed`;`npm test` 361 passed;`npm run verify` 全链通过。
- **排期数据更新提示(2026-09-14,`PLAN-20260914192552`;⚠ 本地验收通过但**尚未推送**)**:排期 750→830 后,
  **已选好片的用户**看不到「自己那场变了什么」。新增 `tools/build_changelog.py`(对比 git HEAD 与当前排期 →
  `public/changelog.json`,本轮 **added 80 / changed 9**)与 `src/changelog.ts` + 顶栏「数据更新」入口
  (`ChangelogDialog`):① 我行程里信息变了的场次(片长/结束时间/标记,给出 from → to)
  ② **我选过的影片的新排期**(本轮 35 场,可一键「加入行程」)③ 本次新增概况(按影院归并)。
  口径要点:**影片身份走 `util.ts::filmNodeKey()`**(不是片名字符串,否则漏掉中文名/原始片名两条路);
  **只记用户可见且影响行程的字段**(`venue_id` / `page` / `title_kr` 不入账,否则 10 + 725 + 35 条噪声淹没 9 条);
  新 localStorage 键 `biff.dataver.v1`(只增不改);**不自动弹窗、不做逐场红点**。
- **官方付印册子并入产物:排期 830 场 / 32 厅 / 影片介绍页 / 票务规则(2026-09-14,`PLAN-20260914184902`;⚠ 本地验收通过但**尚未推送**)**:用户拿到 `2026_BIFF_Ticket_Catalogue_0910ver.pdf`(9/10 付印,104 页)。
  ① **修 `tools/extract_schedule.py` 的 2026 版面适配**(6 处:L8 缺登记 / BT 改名 / 片长被拆成两段 / 多行标题排序 / `[` 不再当备注 / META 行三处切断),`cells_with_extra` 与空标题归零;
  ② **新增 `tools/merge_schedule.py`**:官网(活)为骨架 ∪ 册子(付印)补缺 → **`schedule.json` 750 → 792 场**,
  补入官网排期页**完全不列**的 MEGABOX 1–4(Community BIFF,官方编号 901–942,42 场),
  新增 5 个厅(含 `br` → 官方代码 `bt`),并用册子真实片长覆盖官网 120′ 兜底(002 / 731–735);
  ⚠ 同日修正:册子排期页的 BD(Indieplus)/ C7(CGV 7) 两列是 **P&I(Press & Industry)** 记者/业界场
  (不印编号、不对外售票)→ **不进公开排期**,合成号方案已废(`extract_schedule.py` 跳过 39 个无编号格子);
  ③ **新增 `tools/extract_catalogue_films.py`**:册子 p22–96 影片介绍页 → `FilmItem.catalogue`(格式 / 色彩 / 首映 / 官方英韩简介),
  244 部写入,身份靠场次编号反查 + 「一条目只能指向一个片名」硬自检;
  ④ **`tools/scrape_biff_extras.py`** 增 `ticketBoxes`(官网 HTML,rowspan 感知)与 `--catalogue-pdf` 取册子 p20「入场与观影规则」;
  ⑤ 前端:`FilmDialog` 增「官方节目册」区、`InfoDialogs` 增「票务亭」「入场与观影规则」区;
  ⑥ 新增 `apps/web/tests/catalogue-data.test.ts` 钉住以上口径(32 厅 / 901–942 / 册子片长 / 首映码只认 WP·IP / 票亭 8 处)。
- **修 `sessionFor` 刷新把健康会话打成 401(2026-09-14,`PLAN-20260914181918`;⚠ 本地验收通过但**尚未推送**)**:线上
  `/api/account/me` 先 `503 SERVICE_UNAVAILABLE` 紧跟 `401 UNAUTHENTICATED`,用户被踢出登录。定位到
  `apps/api/src/oauth.ts::sessionFor()` 的 4 个缺陷 —— ① 刷新失败时上游**可能已消费掉 refresh token**
  (轮换非原子);② `invalid_grant` 时**无条件按 `token_hash` 删行**,并发刷新的「败者」会删掉「胜者」刚写入的
  健康会话(401 的直接成因);③ `refresh_until` 无条件归零会**踩掉别人新拿到的租约**,把并发放大;
  ④ 持久化新 token 不读 `changes`,命中 0 行时静默当成功。另外租约 15s 而等待窗口只有 12×200ms=2.4s,
  慢一点就抛 503,而那次刷新其实会成功。改为**条件删除 / 条件释放租约 / 检查 `changes` / 等待窗口对齐租约**,
  并给上游 service binding 调用加**硬超时**(避免挂死拖到 isolate 被回收、留下未释放的租约),
  两条失败分支补结构化日志(只记错误码,不打 token)。
  ⚠ 上游真的消费掉 RT 的那种情况**不可自愈**(better-auth 重用检测会撤销整个 token family),只能重新登录 ——
  本次修掉的是**可避免**的那部分。新增 `apps/api/tests/oauth-session.test.ts`(14 例,`node:sqlite` 当 D1 替身跑真 SQL);
  **修复前 5 failed / 9 passed**(核心两条:并发败者删会话、租约被踩)。顺带修掉 `crypto.test.ts` 一条**既有 flake**
  (篡改 base64url 末位字符有时解出相同字节,实测 5.8% 假失败)。
- **同场观影 & 场次讨论(2026-09-14,`PLAN-20260914164050`;⚠ 本地验收通过但**尚未推送**,见 §7.5)**:「我的行程」叠加
  票务结果层 —— `biff.tickets.v1`(`已抢到 / 没抢到 / 放弃` + `转票` 来源,场次级独立键)+「添加转票场次」弹层
  (按 code / 中英韩片名检索,一步「加入行程并标记转票」)+「仅看实际行程」切换(纯视图筛选 `state === "got"`;
  该视图下不摆顺位卡 —— 票都抢完了)。**正面推翻 2026-09-11 删除抢票三态的决策**(`state.ts` 原注释):它不再是
  本地孤岛,而是新功能的共享数据底座;仍**不复活「售罄」**这类票务系统内部状态。
  同场人数 = 该场**出现在多少人的行程里**(**不看票务状态**,用户拍板「口径最宽」),权重沿用「想看人数」的
  登录 1.0 / 匿名 0.75,**只回聚合数字不回名单**;`GET /api/stats/screening-counts`(人数 + 讨论数一次拿)+
  `POST /api/stats/screening-attendance-ping`(只发 code,1200ms 防抖)。场次讨论 = 公开读 / 登录写,D1 新表
  `screening_post` + `screening_reaction`(**不复用 `festival_document`**),四分类(无料交换 / 物品互换 / 临时约伴 /
  其他)+ 六种 emoji 反应(含点踩 `👎`)+ 作者可删;隐私提示常驻 + 首次说明一次。顺带把「反应 emoji 白名单」「游标分页」
  「讨论分类」三处**上提为唯一来源**(`@biff/contracts/reactions` / `apps/api/src/pagination.ts` /
  `@biff/contracts/screening`)—— 此前 `FeedbackPage` 手抄了一份 emoji 名单。
  ⚠ 迁移 `0005_screening_social.sql` 是**手工裁剪**的:drizzle 只认 `meta/0002_snapshot.json`(0003 / 0004 没留
  snapshot),原样输出会重复创建 `feedback_*` / `film_want_*` 四张**已存在**的表;本地 `db:migrate` 已实跑通过。
  单测 web **30 文件 / 251 例** + api **9 文件 / 68 例**全绿;受影响 19 个 spec desktop-chromium **78 passed**。
  ⚠ 期间修掉一个真 bug:`DialogTrigger` 会**无条件渲染 children**,讨论弹层挂载即拉列表 → 行程页每张卡都发一次
  请求(并**打断顺位拖拽手势**,`parity-agenda` 那条拖拽用例先红后绿);改为 `isOpen` 受控 + 打开时才挂载。
- **同场观影 & 场次讨论 · 追加:社区约定 / 免责 + 点踩(2026-09-14,同一 PLAN 修订 1 / 2)**:讨论弹层加
  **常驻提示 + 首次说明**(四条:只聊电影 / 勿发个人信息 / **本站只是信息发布平台、不对由此产生的任何纠纷负责**
  —— 无论本站还是引流到私下 / 看到不良信息点「👎」)。负反馈**只做点踩** —— `👎` 就是
  `@biff/contracts/reactions` 白名单里的第六个 emoji,走与其它反应**完全相同**的 toggle 路径,
  没有独立的表 / 路由 / 计数口径。
  ⚠ **同日稍晚整体移除「举报 + 管理员后台」**(用户:「先不用管后台了 去掉吧 也不需要举报了 点踩就行」):
  `screening_report` 表与迁移 `0006`、`POST .../reports`、`GET /api/admin/reports`、`ADMIN_SUBJECTS` secret、
  `requireAdmin`、`/admin` 页与顶栏入口、`@biff/contracts/reports` 全部删除 —— 维护「记录 → 后台 → 人工裁决」
  的成本高于收益,要做审核时用作者账号删帖即可。详见该 PLAN 修订 2 与 `docs/CONVENTIONS.md`。
  单测 web **30 文件 / 251 例** + api **9 文件 / 68 例**全绿;受影响 19 个 spec desktop-chromium **78 passed**。
- **Umami 分析接入(2026-09-14,`PLAN-20260914160700`)**:`anaritikusu.citrons.cc` script + website-id；
  React Router / Vite 按[官方 SPA 指南](https://docs.umami.is/docs/guides/track-single-page-apps)只在 `index.html`（含 legacy）挂一次，靠 History API 自动 pageview，**不**在 `useLocation` 里手写 `umami.track()`；`data-domains` 限 `biff.lcandy.co,biff.iff.day`。

- **对齐 BIFF 官网口径:修 4 处错 + 补票务信息(2026-09-14,`PLAN-20260914143817`)**:逐条对官网
  (Newsletter Vol.6–10 / 票务页 11402 / 节目页 11223·11226 / 开闭幕式页 11233 / 排期页 / Selection List)
  核对后修掉 4 处会误导用户的口径 —— ① `festival-extras` 混入 **2025 遗留的 Carte Blanche**(code 338/408
  被本届复用,只按 code 过滤挡不住),改为**按 `dateText` 是否落在展期内**拦
  (`scrape_biff_extras.py::month_day_in_range`);② 影院说明「南浦洞的 MEGABOX 本届未参与」是错的 ——
  Community BIFF(10/8–10/11)就在南浦洞,票务页写明其放映只能在 MEGABOX 4F 票亭预订;③ 大圣崛起 /
  The Violinist 的 `unit` 被 xlsx 覆盖改错(与官网 prog_view 相反,两条正好互换),加 `UNIT_OVERRIDE`
  人工裁决表(不动「xlsx 更细」的通用规则 —— 实测 89 处有价值的细化);④ 开闭幕式弹层原样展示官网典礼页的
  20:20,与排期页 001 场次(18:00)并列会自相矛盾,补口径说明。同时补全票务信息:**购票入口 `ticket.biff.kr`**
  (此前 `.ics` 里写的「购票入口」其实是官方说明页)、在线售票期、**取消与退款三档**、折扣三档适用条件、
  数字弱势群体服务台、客服邮箱;折扣年龄口径订正为官网票务页的「**1961 年及以前出生**」(newsletter 的 1960 不采)。
  新增 `apps/web/tests/festival-extras-parity.test.ts`(10 例,先红后绿:**修复前 6 failed / 4 passed**);
  受影响 5 个 spec desktop-chromium **23 passed**;单测 **36 文件**全过;`npm run verify` 全绿。
  ⚠ 官网自身两处口径冲突已按「节目页 > newsletter」定夺:491 安圣基对谈 = **10/12**(Vol.10 写 10/11);
  开票**只有 9/17 与 9/21 两批**(Vol.8/9 提到的 9/11 不采)。
- **素香剧场分区口径修正 + 新版残留清理(2026-09-14,`PLAN-20260914141643`)**:现场反馈「东西大学 Sohyang Theatre
  显示分区在南浦洞」。实读定位:**错的只有旧版** —— `legacy/src/legend.ts::GROUP_AREA` 把 `sohyang`/`bcm` 归到
  nampo(与官方三区模型 `docs/history/2026-09-09-开发落地记录.md:263` 相左,是 2025 导入时的误归),
  新版 `src/legend.ts` 与 `venues.json` 的 `region` 早已是 `centum`。改旧版两行 + 同步
  `legacy/source-manifest.json`(冻结闸门);新版侧把 `FilterBar` 的「南浦洞」死控件改为**按数据渲染**
  (`filters.ts::regionPresets` —— 2026 无厅落在 nampo,故不渲染;换回有南浦洞场次的届次自动出现)。
  新增 `apps/web/tests/venue-region-parity.test.ts`(数据 ↔ 新版文案 ↔ 旧版文案逐字一致,先红后绿)
  与 `filters.test.ts` 4 例;web 单测 **28 文件 / 232 例全绿**。
- **建议反馈留言板(进行中 / PR,`PLAN-20260914134700`)**:`/feedback` 公开可读；登录后发帖与五类 emoji 反应（👍❤️🎉💡👀）；
  D1 `feedback_post` / `feedback_reaction`（不复用 `festival_document`）；顶栏「建议」入口。
  remote 迁移随 main Builds；本机不改 wrangler `account_id`。
- **规范补两条:大改动走 PR + 大重构前打 checkpoint(2026-09-14,`PLAN-20260914101945`)**:提交复盘
  (`gaaiyeoi` 121 条 vs `citron` 14 条;平均 5.2 文件 / 148 行 vs **157.8 文件 / 4637 行**)后,把 citron 侧
  **两条值得保留的做法**补进三层规范 —— ① **§4.5 PR 流程**:默认仍直接 push main,但**大规模重构 /
  涉及 `apps/api` 或 D1 迁移 / 依赖升级**三类走 PR,换 Review 记录 + Verified 签名 + 「CI 在合并前跑」
  (`prepare-cloudflare.mjs` 只在 `WORKERS_CI_BRANCH=main` 时迁移 + 部署,PR 分支天然不碰生产);
  ② **§4.6 checkpoint 提交**:大重构动手前打 `chore(<scope>): checkpoint before <重构名>`,自身必须全绿、
  不含半成品,作用是出问题时 `git reset --hard <checkpoint>`,且**不能替代原子提交**(反例:`4feda07`
  打了 checkpoint,紧随的 `fe82988` 仍是 128 文件 / 18806 行的单提交)。
  ⚠ 顺带订正:AGENTS.md / RULE.mdc 里「绕过 `pre-push` 只能用 `--no-verify`,而那是**红线 12**」编号有误
  (`--no-verify` 不在 §8 红线清单里,红线 12 是 `wrangler pages deploy`),改为指向 §4 禁止项。
  纯文档改动,`git diff` 只含 `*.md`。
- **双前端账号一体 + 桌面 1:3 分栏 + 想看人数加权(2026-09-14,`PLAN-20260914003600`)**:Legacy 薄登录/同步桥（共享 cookie + `biff.*` + sync 核心）；
  新版桌面 ≥1100 选片/行程:排片 = 1:3 挤压分栏、工作台 max-width 1600px；D1 `film_want_*` +
  `GET/POST /api/stats/want-*`（登录 1.0 / 匿名 0.75 film-key ping，`Math.round` 展示于影片库卡与详情）。
  ⚠ 本机 wrangler 若非 `62cbe67b…` 账号，**不改 account_id**；remote D1 migrate 随 main 部署。
  分支 E2E 收口（`PLAN-20260914023243`）：恢复「体验新版」、面板宽改 1:3 比例断言、countdown `pauseAt`；
  本地 desktop-chromium 指定 8 个 spec **32 passed**。
- **main E2E 大面积失败修复(2026-09-13,`PLAN-20260913225149`)**:CI run `34757140825` 门禁绿、E2E 64 红。
  根因是测试未跟 UI 演进（标题含年月、`iffday.workspace.*` guest 缓存、`?quick=1` 浮层、三档排片大小 0.45/0.55/0.75、
  日轴裁剪、GV「未选→加入并参加」、legacy「体验新版」），外加边界标签 `height:0` 对人可见但对 Playwright hidden、
  资料弹层滚动恢复被 Spectrum autofocus 盖掉。产品侧修边界盒模型 + FilmDialog 多帧恢复；E2E helpers 排除 `iffday.*`
  并补 `scheduleHeading` / `openViewingPanel`。desktop-chromium 先前红簇 **53 passed**。
- **IFFDAY 账号体系 + 前后端分仓(2026-09-13,`cbead95` / `8a54eca` / `26b21e0`)**:仓库从「纯静态单页」改为
  **npm workspaces 三包** —— `apps/web`(React + Router + Spectrum S2)、`apps/api`(Hono + Drizzle,既是公开入口
  又是 `/api/*` 服务)、`packages/contracts`(前后端共享 Zod 契约 + canonical JSON)。**接入 IFFDAY OIDC**
  (账号中心 `https://account.iff.day`,客户端 `biff-scheduler`):授权码 + PKCE S256,校验 state / nonce /
  issuer / audience / ID token 签名;cookie `__Host-biff.session` 只存随机 token,OAuth token 加密存 D1;
  后端靠 service binding `IFFDAY_API` 校验身份,全程不依赖第三方 cookie。**片单同步**:访客仍只存本机,
  **登录后**同步到该账号自己的 D1 文档(`festival_document`,`edition=biff-2026`,revision 乐观锁 +
  operationId 幂等),`account_import` 保证每账号只自动导入一次本机数据,且「写片单 + 标记已导入」在同一
  D1 batch 内原子提交;`iffday.workspace.owner.v1` 按 owner 隔离缓存,切换账号不会把上一位用户的片单传上去。
  详见 `docs/account-integration.md`。
  ⚠ **域名**:生效的是 `https://biff.lcandy.co`;`biff.iff.day` 已进 `APP_ORIGIN` 白名单与账号系统回调登记,
  但**自定义域名未挂到 Worker 上**(该子域无 DNS 解析),需人工在 CF 控制台挂载。
  ⚠ 本条目是 **2026-09-13 文档漂移修复**(`PLAN-20260913190500`)的回写 —— 此前 §1/§4 仍写「零后端 / 没有 API」,
  已一并订正。
- **豆瓣入口落在「片名右侧」(2026-09-13,`PLAN-20260913184357`)**:用户先要求把影片卡操作行里的
  「豆瓣」外链顶到行右端(`PLAN-20260913183205`,该放置已被取代),再看效果后要求搬到「片名后面」。
  中间一版只做了「我的行程」场次卡、并把影片卡上的入口删掉,用户随即反馈「我的选片里看不到」
  (该片「未排场」,行程里根本没有它的场次卡)—— 修订为**两处片名行都给入口**:
  影片卡(`/library` `/picks`)的 `h2` 右侧、「我的行程」场次卡的 `h3` 右侧,共用
  `.title-row` / `.douban-jump` 一对类(品牌色 + `↗`、hover 下划线,与卡片里「在 Google 地图打开 ↗」
  同一套外跳语言);入口一律放在标题标签**之外**做兄弟节点 —— 塞进标题会把标题的 accessible name
  变成「片名 豆瓣 ↗」。底部操作行不再放外链。外链 URL 收敛到 `util.ts::doubanUrlOf(film, map)`
  (映射优先、否则按中文名→英文名搜索),资料弹层同步改用同一函数。
  单测 +4(`film-score.test.ts`);`parity-agenda` + `parity-library` 加回归,共 21 条全绿。
- **把「靠人记住的规范」改成「机器能挡的闸门」(2026-09-13,`PLAN-20260913201727`)**:盘点后确认
  **规范写得比执行得好** —— §0–§9 全是要人记住的条款,真正能挡错误的只有云端那一步 `npm run build`
  (且不含 E2E)。本轮七项:
  ① **仓库卫生**:删掉三个被误提交的会话草稿(`findings.md` / `progress.md` / `task_plan.md`,
  来自 `fe82988` / `14c29b1`),新增 `scripts/check-repo.mjs`(根目录白名单 + 禁止被跟踪的
  构建产物 / 密钥 / 缓存 / 日志,带 `--self-test` 正负对照),串进 `verify:quick` / `verify`
  (刻意**不进** `build` —— 云端不保证有 `.git`,不能让卫生检查挡住生产部署);草稿落点定为
  工具中立的 `.scratch/`(不绑定任何 IDE)。
  ② **CI**:`.github/workflows/ci.yml` —— PR 跑 `verify:quick` + 受影响 spec(单浏览器),
  `main` push 跑全量三浏览器。此前仓库里**根本没有 `.github/`**。
  ③ **`apps/api` 单测**:+39 条(`crypto` 加解密与 purpose 隔离 / `config` origin 校验 /
  `contracts` 序列化),落 `apps/api/tests/`(见该 PLAN 修订 1:放根 `tests/` 会因 DOM 类型程序
  与 Workers 类型环境冲突而炸)。单测总数 228 → **267**。
  ④ **`docs/TEST-MAP.md`**:改动路径 → 必跑 spec,机读源 `scripts/test-map.json`,
  `--check` 断言两者同步(避免「同一口径两份实现」)。
  ⑤ **提交门禁机械化**:`scripts/git-hooks/{commit-msg,pre-push}` + `install-git-hooks.mjs`
  (挂 `prepare`,永不阻断构建);零依赖,刻意不引 husky / commitlint。
  ⑥ **`docs/legacy-retirement.md`**:legacy 冻结条款 + 退役判据 + 8 步清单。
  ⑦ **Dependabot**:按月分组升级。
  规范三层(AGENTS.md / DEVELOPMENT-STANDARDS.md / RULE.mdc)同步更新。
- **规范新增「§9 与 AI 协作的约定」(2026-09-13,`PLAN-20260913201058`)**:§0–§8 只定义「AI 拿到需求**之后**怎么做」,
  缺上游那一半 —— **需求怎么提 / 变更怎么记 / 交付物长什么样**。本轮补齐:`AGENTS.md` 与自动加载副本
  `RULE.mdc` 各加精简 §9,完整版落在 `docs/DEVELOPMENT-STANDARDS.md` §9(原「变更记录」顺延为 §10)。
  核心口径:① **人只描述「症状 + 约束」,不指定实现**;② 三档需求(普通功能 / 大重构 / 推送发布)各有固定的
  「必须先交」与「收口证据」;③ 五条话术纪律(不指定实现 / 说清不能影响什么 / 需求变了改 PLAN 文件 /
  给 AI 反驳诊断的空间 / 长期约定写进规范);④ 可复制的 PLAN 模板 + 交付物清单 + 6 条反模式。
  纯文档改动,`git diff` 不含任何 `*.ts`/`*.tsx`;`verify:quick` 全绿。
- **「在 Google 地图打开 ↗」贴住影院地名(2026-09-13,`PLAN-20260913192048`)**:「我的行程」场次卡影院块
  里,地图入口原本带 `margin-left: auto` 被顶到行右端,与左侧地名(`LOTTE 9` /
  `LOTTE CINEMA Centum City · 乐天影院 Centum City`)之间隔出上百像素空白。用户要求它**像 `豆瓣 ↗`
  紧贴片名那样紧靠着地名** —— `agenda-parity.css::.venue-map-link` 去掉 `margin-left: auto`,
  外链退化为 flex 行里的普通项,只留 `.screening-venue-head` 的 8px 列间距(视觉 / `href` / `title` 不变)。
  `parity-agenda` 加 1 条回归(`getBoundingClientRect` 量入口与前一兄弟的间距 ≤ 16px;改前实测 878px);
  `verify:quick`(单测 224 + 4)与 `parity-agenda` 12 条全绿。
- **移除行程最后一场不再连带删掉选片(2026-09-13,`PLAN-20260913180837`)**:`toggleScreening()`
  / `removeScreening()` 原先在「最后一场 + 无备注」时走 `isOrphan()` **整条删记录**,与 `types.ts`
  / 帮助弹层 / 卡片 tooltip 三处「移除场次 ≠ 取消选片」的承诺相左(用户实测:只排一场的片在行程里
  移出后,整部片从「我的选片」消失)。新口径:**移除某一场只动 `picks`,记录一律保留** ——
  `picks` 为空 = 合法的「已选未排场」态(与 `addPickFilm()` 的空记录同构),选片卡状态行显示
  「未排场」;要真删走显式的「移除影片」(`removePick()`)。`clearScreeningSlots()` /
  `replaceScreenings()` 的批量清空**保持原样**(设置弹层已明示「有备注的保留,其他空记录会删除」,
  属另一条已披露口径)。单测 210 → **220**(`apps/web/tests/state-picks.test.ts` 10 条);
  `parity-library.spec.ts` 加 1 条回归 + 修正 2 条用例里整页视图下点不到的「打开我的观影」入口。
- **TMDB 海报(2026-09-12,`PLAN-20260912213000`)**:对照 piecelet-api-relay 的 `/tmdb` 中继
  (Bearer v4 token),离线搜本届片目并下载 `image.tmdb.org` 的 w185/w500。
  **token 只读环境变量 `TMDB_KEY`,不进仓库**。246 部里命中 204,`films.json` 海报 156→228
  (其中 203 张换成 `/posters/tmdb-<id>-m.jpg`);未命中仍用原来的豆瓣图。
- **排片表 / 时间线海报与评分 + 详情简介(2026-09-12,`PLAN-20260912204312`)**:
  网格卡横向 `[海报 | 正文]`,片名行右侧豆瓣章带人数(`豆 8.5 1.6万`);窄卡 / 矮行藏海报。
  时间线卡左缘海报 + 场次行流里同一枚评分章。详情弹层在海报区下方展示豆瓣 `intro`。
  简介产物 `public/douban-intros.json`(按 subject_id,本轮 33 篇后风控停下,续跑 `--delay 3`);
  映射补读 rating / rating_count。单测 168 → **173**。
- **豆瓣相关电影(2026-09-12,`PLAN-20260912195707`)**:
  离线拉 Frodo `GET /api/v2/movie/{id}/recommendations`(每部最多 20 条 movie),写入
  `public/douban-related.json`(**220 subject / 162 有推荐 / 58 空 / 126 部能对上本届片目,共 676 对**);
  资料弹层豆瓣区下方追加两段 —— **本届也在放**(推荐 id 命中当前 mappings,整行压栈打开那部资料)
  与 **豆瓣也推荐**(其余最多 6 条外链)。`/related_subjects` 实测是原著/OST 且本届样例常空,不接。
  文件缺失静默降级。单测 162 → **168**(`tests/related.test.ts`)。
- **导入支持 .ics + 已保存方案改横向(2026-09-12)**:
  - 「导入数据备份」弹层**按内容自动识别类型**:带 `BEGIN:VCALENDAR` → **.ics 排片导入**,
    否则走备份 JSON;文件入口 `accept` 同时收 `.json / .ics`,粘贴文本同样识别。
    `.ics` 只能恢复**场次**(反解 `UID:<code>@biff-2026`,自动滤掉开票日历的 `biff-ticket-*`),
    故多一个**合并 / 替换**二选一(**默认合并**);不在当前排期的 code 静默忽略并在状态行报数。
    纯逻辑 `backup.ts::parseIcsCodes` + `state.ts::mergeScreenings / replaceScreenings`
    (替换**只清场次**:有备注的记录降级为「未排场」,被清场次的顺位由 `rebuildIndex()` 一并 prune);
  - **已保存方案改横向滚动卡片流** —— 原来一行一个纵向堆,存多了把下面的行程顶下去;
    现在每张卡固定 212px(方案名 / ✕ / 场次数 · 日期区间),高度恒定两行,存多少都不占纵向空间。
  单测 153 → **162**;无头验收:.ics 识别(2 场,开票 UID 被滤)/ 默认「并入」选中 → 切到「替换」→ 落盘
  (375+419 → 只剩 419)/ 备份 JSON 路径不受影响(icsBox 隐藏、按钮文案回到「导入并覆盖本机数据」)
- **顺位撞车(逐层)+ 一键修复 · 保存方案 · 按方案导出(2026-09-12)** —— **方案从「系统枚举的对比列表」
  改为「用户手动存的快照」**:
  - **顺位撞车(逐层)**:两个冲突组在**同一层**(各组第 k 场)撞到同一部片时,那一层的组合会被
    「同一部片只留一场」剔除,用户看不出原因 ⇒ `plans.ts::detectRankClashes` **逐层**检出
    (只查**对齐的层**,不查跨层同片 —— A 组顺位 1 与 B 组顺位 2 同片属正常备选关系),
    行程顶部出**黄框提示**;每条撞车给**逐组让路**按钮(交换该组第 k 场与组内第一个不同片的场次),
    外加**一键全部修复**(`plans.ts::autoFixRanks` 贪心 —— 每步挑「让路后剩余撞车最少」的组),
    点开**先出预览**(`OCT 11 · 19:00·375 → 17:50·419 ⇒ …`)、确认后才落盘;
  - **保存方案**:行程顶部「保存当前方案」把**第一顺位方案**(每组顺位 1 + 共同场次)存成快照
    (`biff.savedplans.v1`,**场次集合去重**、自动命名「方案 N」、可删除);第一顺位有撞车时**禁用保存**;
  - **按方案导出**:「导出 · 分享」菜单 → 新弹层(`src/export-panel.ts`)**先选方案**(默认最新)
    → [导出 .ics] [分享文案] [分享图片];没有任何已保存方案时三项禁用 + 提示先保存;
    「导出数据备份 / 导入数据备份」留在菜单里不动(与方案无关);
  - **原「方案对比 · N 套」枚举区整体下线**(`plans.ts::buildPlanSet` 仍产出 `options`,
    因为 `broken` 靠逐套校验;只是 UI 不再展示)。
  单测 144 → **153**(`plans` 逐层撞车 + `autoFixRanks` 7 条、新增 `tests/saved-plans.test.ts` 8 条);
  无头验收:撞车提示(第 1 顺位 · 2 组)/ 一键修复预览 → 确认(ranks 落盘、提示消失、保存按钮解禁)/
  保存方案(去重 toast「这套方案已经存过了」)/ 导出弹层(选方案 + 三按钮 + 无方案时禁用)
- **移动端极端适配(2026-09-12,`PLAN-20260912002532`)**:窄屏(≤768px)**不再「列表优先」** ——
  二维甘特在 390px 竖屏要横滚 4 屏 + 纵滚 26 行,形态本身不可用,旧口径把抽屉当主视图,
  于是用户报「一打开就是影片库,时间轴被挡住了」(实际是 `#main-col` 被 `display:none`)。
  现在窄屏走**单日纵向时间线**(新增 `src/timeline.ts`):一列、按开始时间升序、左缘时间轨
  (竖线 + 每场时间点 + `HH:MM`),每张卡 = `row.ts::screeningRow`(**零新排版**),
  底色类组合与网格 `cardStateOf` 同源(冲突红 / 已选绿);加入 / 移出 = **整卡点选**(复用既有委托);
  卡间连接件**只画在相邻两场都已选之间**(赶场间隔 / 重叠,口径同 `agenda.ts::gapConnector`);
  `#zoom-ctl` 窄屏隐藏、时间线不限高(走页面滚动)、始终全量重建;窄屏默认日期 = **今天**(在展期内时)。
  抽屉退化为次级「列表 · 行程」视图(顶栏进入 / 全屏),出口文案窄屏换成「◀ 时间线」。
  **PC 端零影响是硬约束** —— `grid.ts` / `style.css` 一行不改,所有新逻辑挂在 `isMobileDrawer()` 之后;
  单测 120 → **138**(新增 `tests/timeline.test.ts` 14 条 + `pickDefaultDate` 4 条);
  无头验收:桌面(二维网格 / 缩放 100%→120% / 抽屉挤压式 / 出口文案「收起 ✕」/ 限高在)
  与窄屏(时间线 96 张卡按时间升序 / 缩放隐藏 / 默认不弹抽屉 / 点卡不弹抽屉 / 红绿底色 / 连接件 / 「◀ 时间线」往返)全绿
- **页脚贡献者署名(2026-09-12,`PLAN-20260912001500`)**:`#page-foot` 在「数据来源 / 版权」段后追加
  **两个贡献者的 GitHub 主页外链**(`@gaaiyeoi` / `@lcandy2`,取自仓库全量提交者,仅此两人)。
  **样式零新增** —— 页脚本就是 `flex-wrap + gap + text-center` 的单行流,追加一个 `<span>` 即多一列、
  窄屏自动折行;链接色沿用既有的 `#page-foot a`(默认灰、hover 品牌红)。
- **抢票信息 + 节目嘉宾 + 开闭幕式(2026-09-11)**:新增离线管线 **`tools/scrape_biff_extras.py`** →
  `public/festival-extras.json`(**开票批次 / 票价 / 购票须知** + **节目嘉宾**(Master Class / Actors' House /
  Cine Class / Special Talk,含嘉宾中文名映射)+ **开闭幕式红毯时间表 + 封路**;只保留 `schedule.json` 里
  真实存在的 code,自动滤掉官网页面上的往届遗留条目(如 2025 的 Camellia Award 得主)。
  前端:`src/extras.ts`(加载 + 开票时刻 KST 文本解析 + 票价推算)、`src/ticketing.ts`(顶栏**开票倒计时**横幅
  —— **同时给北京时间与韩国时间**,官网印 KST、国内看 KST−1h;+ 「抢票信息」弹层 + 开票日历)、
  `src/ics.ts::buildTicketIcs`;网格卡徽章行**最前**加「活动嘉宾章」(`legend.ts::guestChip`)、
  详情弹层加「活动节目」区(`modal.ts::buildProgramBlock`);行程行加票价章 + 日期头当日小计 +
  摘要行总花费(`票 ₩XX,XXX`)。**数据缺失一律静默降级**(无 extras 时横幅隐藏、票价回落普通档)。
  单测 **113 → 120**(新增 `tests/extras.test.ts`)
- **部署口径修正(2026-09-11,`PLAN-20260911233000`)**:线上 = **https://biff.lcandy.co**
  (Cloudflare **Workers** 静态资源,CF 账号 `62cbe67b…`),**推 `main` 即触发 Workers Builds 自动部署**
  (GitHub 上可见 `Workers Builds: biff-scheduler` 检查,`2e1007d / 81d5f12 / 71f0394` 连续 success);
  旧的 **Pages 项目 `biff-scheduler.pages.dev`**(账号 `c591765d…`,本机 wrangler 默认登录的那个)
  **已不在访问链路上** —— `wrangler pages deploy` / `npm run deploy` 直传作废(判别方式与坑见 §9.2);
  README(线上徽章 / 快速开始 / 技术栈 / 部署段 / skill 表)、`docs/CONVENTIONS.md`(部署纪律)、本文件相关说明已同步
- **分享图片(行程图)(2026-09-11,`PLAN-20260911231000`)**:导出菜单新增**第二个分享类型** ——
  「分享文案(纯文本)」旁并列「分享图片(行程图)」。`src/poster.ts`(模型 + 几何 + canvas 绘制)与
  `src/poster-panel.ts`(预览弹层 + 复制图片 / 下载 PNG)分层,后者才 import `modal.ts`(前者可 node 单测)。
  **手绘 canvas,不用 html2canvas / 截图**:零依赖、不受应用主题 / 抽屉宽度影响(海报固定深色)、
  按海报重排信息(日期分节 + 影片海报缩略图 + 时间 / 片名 / 影院 / 备注)而不是把屏幕缩小。
  口径全部复用:排序 / 概要走 `share.ts::orderedPickRows` / `shareSummary`(本轮从 `buildShareText` 抽出),
  单场走 `effEndMin` / `displayTitle` / `venueShort`;长图退档(>8000 逻辑高回 1×)避开画布单边 32767 上限
  导致的 `toBlob` 静默空图。单测 102 → 113
- **数据备份 / 迁移(2026-09-11)**:片单只存 localStorage、**按 origin 隔离** —— 绑定新域名后用户看到的是空数据;
  入口在顶栏「导出 · 分享」菜单(与 .ics / 分享文案并列,不占设置弹层):
  `backup.ts` 按 `biff.` 前缀快照**全部**本机键(**不写死键清单**,将来新增视图偏好键自动带上),
  `backup-panel.ts` 的「导入数据备份」弹层(选文件 / 粘贴文本两条路,整体替换 + 覆盖确认 + 刷新);
  纯逻辑与 DOM 分层(前者可在 node 单测直接导入),单测 9 条(`tests/backup.test.ts`)
- **豆瓣官方 API 接入(2026-09-11,`PLAN-20260911223200`)**:新增 `tools/frodo_client.py`(签名协议层)、
  `tools/douban_match.py`(检索→确认→置信度,两个产物脚本同源)、`tools/build_douban_map.py`
  (films.json → `public/douban.json`);`enrich_douban.py` 的检索通道从网页口 `subject_suggest`
  (**静默限流 + CAPTCHA**,只能 60s/请求)换成官方口(1~2s/请求)。
  **实测踩坑**:① 文档推荐的 `search/subjects` 跑约 100 次后 `403 need_login`,而登录/token 刷新流程未恢复 →
  改用匿名的 `search/suggestion`(+`mix_suggest_subjects` 兜底);② 详情口也会 **IP 级风控**
  (`code=1309 subject_ip_rate_limit`)—— 此时检索仍返回 200,**极易被误记成「豆瓣没有这部片」**,
  故 `{103,1005,1309}` 定为风控码,命中即停轮保进度。本轮产出 **82 部 / 355 键**全 `high`(剩余 164 部待风控解除后续跑)
- **方案对比:同一部片只留一场(2026-09-11,`PLAN-20260911230500`)**:用户报「最优先」那套里出现
  `027+071` 两场《峡湾》—— 027 / 071 是**同一部片**、分属两个冲突组、各自又都是组内顺位 1,
  枚举把「同片多场」当成了两个互相独立的槽位。`plans.ts::buildPlanSet()` 增 `filmKeyOf` 注入
  (走 `util.ts::filmNodeKey`,与影片库 / 详情弹层同口径):一套方案里出现两部同片即**剔除**
  (记账 `droppedSameFilm`,方案对比区据此交代「为什么少了一套」);兜底 = 全判死时退回不去重结果。
  单测 **98 → 102**
- **拖动顺位 = N 套方案 + 删除档位(2026-09-11,`PLAN-20260911223000`)**:
  「我的行程」的冲突组**顺位卡**(**绿框 = 已处理好,不是警报**)内可**拖动排序**(卡片头第 1 列的 `⠿` 把手),
  顺序即**抢票顺位 = 偏好次序**;**顺位不决定分组** —— **方案 = 「每个冲突组各取一场」的所有组合**,
  `plans.ts::buildPlanSet` 枚举 + 逐套校验无冲突,行程顶部「方案对比」**全部**并列(按顺位成本排序,只列差异场次);
  **档位(必看 / 备选 / 随缘)整体删除**(`src/pick.ts` 删除):冲突决策由顺位接管,
  非冲突场景里它只剩排序噪声;`score.ts` 改为「场次数 + GV − 紧转场」
- **日期口径统一 + 选片日期多选(2026-09-11,`PLAN-20260911213952`)**:`util.ts::dateInfo` 只留一个 `label` 字段,
  全站日期一律印官方写法 **`OCT 8`**(网格标题 / 选片日期 chips / 行程日期头 / 分享文案;顶栏日期条同源),
  不再出现 `10/8` 这类数字写法;「我的选片」日期筛选由单选改**多选**(`dateSel: Set<string>`,空集 = 全部)
- **片名口径 = 「英文名 · 中文名」(2026-09-11,`PLAN-20260911172000`)**:全站片名(网格卡 / 影片库 / 我的选片 /
  我的行程 / 资料弹层 / 复制清单 / tooltip / `.ics` SUMMARY)统一由
  `util.ts::bilingualTitle` 产出 —— 英文名在前、中文名以 `·` 跟在后面;任一侧缺失只留一侧、同名只印一次
- **数据届次 = 2026 第 31 届(2026-09-11 切换)**:官网排期页抓取(`tools/scrape_biff_web.py`)→ **750 场 / 26 厅 / 10 天(10/6–10/15)**;影片目录 = 官方 xlsx → **250 部**。2025 第 30 届的 699 场(699 场 / 29 厅 / 224 部)已在 git 历史
- **排片筛选(2026-09-11)**:网格支持按 **字幕 / 影厅 / GV** 过滤(多选 + 三态单选;只淡出不隐藏,不跳版);
  **影片库接入同一份状态**(`src/filters.ts` 单一模块,网格铺开三行 / 抽屉可折叠);控件是**圆角矩形**(不是胶囊)
- **海报(2026-09-11)**:`films.json` 的 `poster` 按豆瓣 subject_id 对齐 `public/posters/` 的本地图(**174/250**);
  影片库卡片 44×62 缩略图 + 资料弹层 124×175 大图;缺图不留空列(见 `PLAN-20260911170000`)
- 脚手架:Vite+TS(**2026-09-13 起前端为 React**,旧的无框架版仍在 `apps/web/legacy/` 且仍在产物里);
  部署目录 `dist/`(前端 Worker `biff-scheduler-web` 的 `[assets] directory = "./dist"`);
  无账号时代的 `functions/` 已于 2026-09-11 退役;D1 于 2026-09-13 因账号同步重新引入(**仅存账号片单**)
- 核心排片:自研 CSS Grid 网格(影院×时间)、点选加入行程、时间重叠红标(冲突组 + 跨行连线)
- 行程视图:自研议程列表(按日分组;冲突组折叠成**绿框顺位卡**,**拖动排顺位 → N 套方案并列对比**)—— 不用 FullCalendar(见 §2 决策)
- 导出:`.ics`(UTC、GV 场次时长已含 +25min);分享文案复制(贴微信)
- 影片库:films.json 250 部目录接入,搜索(中/英/code/导演/单元)+ 单元筛选 chips + 反向定位(跳转并滚动闪烁)
- 豆瓣:静态映射(`public/douban.json`,离线产物)+ 中英文搜索兜底;不做爬虫
- ~~M2.5 智能排片~~:**AI 排片已于 2026-09-11 整体下线** —— 影片库 / 行程 / 质量分保留,
  `ai.ts` / `ai-panel.ts` / `ai-prompt.ts` 与相关 LS 键(`biff.ai*`)、设置项、单测全部移除
  - 历史:2026-09-10 原本地确定性求解 + `planScore()` A/B 方案卡**已整体下线**(PLAN-20260910143516);
    `engine.ts` 已更名 **`score.ts`**(PLAN-20260910232833),现仅保留**行程质量分** `scorePlanRows()`(服务「我的行程」头部 `分 N` 药丸)
- 视觉:BIFF 黑白红风对齐(官方抓取 #ce1e36)+ Design Token 化(:root 分层 token)+ Tailwind v4 增量接入
- 品牌素材接入(brand/):wordmark/favicon/footer,含许可约束(见 §8)
- 排片表字段徽章 + 图例总览:`legend.ts` 单源 — 等级(ALL/12/15/19)、字幕/对白标识(KE/KN/KK/NO/未标注)、节目册页码、片长 全部以小徽章流渲染(网格卡 / 行程 / 影片库 / 详情),每枚 data-tip 即时说明;场馆行显示官方代码 chip + 整行 hover 全名/韩名/分区/代码 说明;顶部「ⓘ 日程表说明」点击打开总览弹层(字段速读示例 / 等级 / 字幕 / 徽章 / 影院代码本工具行 + 2025 官方代码总表 references / 网格图例 / P&I·开闭幕·GV·节目册 特别提示)
- 网格卡选中态改"底色交互":`in-plan` / `hl-card` 移除左侧 3px 优先级竖条 + 优先级色外晕,改用整卡 `color-mix(--pc 14%, card)` 淡底色染色(must/maybe/wild → 红/琥珀/灰);与紧转场整卡底色同一交互语言
- **存储与适配(2026-09-10,PLAN-20260910235630 / PLAN-20260910235000)**:
  **片单(选片 / 排片)只存 localStorage**、云端 `user_pick` 整体退役(见 §2 D5)—— 清空后刷新 / 部署不再复活;
  设置里新增「清空全部(选片 + 排片)」;
  暗色**跟随系统**、~~窄屏 ≤768px 列表优先~~(2026-09-12 改为**单日纵向时间线**,见 §0 首条)、
  字阶/圆角**值命名 token** 生效、按钮类名收敛到 `ui.ts`
- **零后端(2026-09-11,PLAN-20260911001107)**:D1 整体退役 —— 豆瓣映射改静态 `public/douban.json`
  (`/api/mapping*`、`functions/`、`migrations/`、`wrangler.toml` 的 D1 绑定、`migrate:remote` 全部删除);
  弹层豆瓣区只读(条目直链 / 中英文搜索兜底);顶栏 `#sync-dot` 与 `renderSync()` 删除。
  ⚠ **该状态已于 2026-09-13 部分回退**:账号同步重新引入 D1(`biff-account-data`)与 `/api/account/*`,
  但**豆瓣映射 / 排期仍是静态 JSON**,`/api/mapping*` 与 `functions/` **没有回来**(见 §4)
- **工程化(2026-09-11,PLAN-20260911000705)**:接入 **PWA**(预缓存产物 + 只读 JSON → 现场断网可用;
  方形 PNG 图标 192/512 + iOS 180);**Vitest 单测**(24+ 时制 / GV 有效结束 / 冲突)并接入 `build` 门禁;
  抽屉列表行加 `content-visibility: auto`(渲染优化,非完整虚拟化);
  `ui.ts::extraCls` 确立为**布局 / 变体专用**契约(试过 tailwind-merge,成本 gzip +9.7KB 换 0 调用点,已撤,见 §7.8)
- **全量审查后的优化轮(2026-09-11,PLAN-20260911004000)**:补完 D1 退役的删除步骤(`src/api.ts` / `functions/` / `migrations/` /
  `wrangler.toml` D1 绑定 / `migrate:remote` 全删,产物内 `/api/` = 0 次);
  状态层上 `groupIndex` + `slotIndex` 原地重建 + `mutate()` 批量出口 + 微任务合并广播(批量改动不再 O(n²) 写盘 / 重渲染);
  `codesOfGroup()` O(1);新增 `Catalog.filmByZh/filmByOrig` 影片索引(消除 O(screenings × films) 线性扫描);
  **`.ics` 正确性修复**:RFC5545 转义(`\` `;` `,` 换行)+ 按 **UTF-8 字节**折叠 + VALARM DESCRIPTION 补折叠;
  **弹层可访问性**:`role=dialog` / focus trap / 焦点归还 / body 滚动锁 / `aria-live` toast;
  **触屏与键盘可达的 tooltip**(旧版触屏永远看不到 `data-tip`);
  跨文件重复的转场余量判定收敛为 `util.ts::slackBetween()` 纯函数;**单测 53 → 63**(新增 `tests/ics.test.ts`)
- **渲染层重构(2026-09-11,PLAN-20260911004000 §3.1)**:网格改为「**几何签名不变 → 就地 patch**」——
  `gridGeometryKey()`(内容签名,含起止 / 片长 / GV 时长)+ `patchGridStates()`(含「先清上一轮内联紧张底色」这条关键不变量);
  卡片状态抽成纯函数 `cardStateOf()`(构建 / patch 共用,node 可单测);徽章行按场次**模板 clone**;
  **订阅分域** `ChangeDomain`(theme 域跳过网格与抽屉重绘);`notify` 加**订阅方隔离**(单个抛错不再让其余静默不刷新);
  单测 **63 → 78**(新增 `tests/grid-state.test.ts`)。浏览器实测见该 PLAN §3.2

**⏳ 待办(按序,详见 §7)**
1. 9/11 官方排期发布后 M1:真数据管线 + venue 名单核对(删 mock 的 mega-haeundae,补南浦)
2. 真机手测残留清单(网格 hover 联动、gap-bar、wish→行程全链路等,见 §7.3)
3. P1-5 Transit Matrix / P2-7 冲突文案细分 / P2-8 内联 SVG / P2-9 视觉收口(均未做)
4. C6 中文时间表达归一(2026-09-10 加,PLAN-20260910145749):修「下午五点开始看」被误读为「16:00 OK」
5. **`conflict.ts::computeConflicts` 的 `transitFor` 是死参数(文档债,非行为 bug)**(2026-09-11,PLAN-20260911000705):
   内层 `if (b.start >= a.end) break;` 在追加 transit **之前**就中断,而 `a.end + transit > b.start` 在该 guard 下
   对任何 `transit ≥ 0` **恒真** → `transitFor` 对结果零影响,该函数实际是 **overlap-only**。
   **但产出的行为是对的**:红绿灯语义刻意如此 —— `style.css` / `grid.ts` 注释均写明「红 = 完全冲突(时间重叠)」、
   「黄 = 时间紧张」;「跨馆余量不足(赶不上)」由 `grid.ts::markTight`(`bad = slack < 0`)**黄卡**覆盖,
   行程页 `agenda.ts::gapConnector` 还会显示红色粗体「⚠ 赶不上」。**没有漏报。**
   ⚠ **勿「修」成让 transit 参与红色判定** —— 那只会把黄卡变成红卡,与既定语义相左。
   该做的只有两件:① 删掉 `transitFor` 参数(或改成注释说明该函数是 overlap-only);
   ② 订正文件头「先结束的场次 end 追加 transit 再判重叠」那句与实现相左的注释。
6. **`transitMin`(跨馆转场缓冲)的实际作用面**(默认 0):`grid.ts::markTight`(黄卡:不足 / 偏紧)、
   `agenda.ts::gapConnector`(赶场间隔「⚠ 赶不上」)、`score.ts`(紧转场 −1 计数)。
   **不参与** `conflict.ts` 的红色判定(见上条)。
7. **完整虚拟滚动未做**(2026-09-11):甘特卡靠 `centerCardX` 读 `offsetWidth/offsetLeft` 做反向定位居中,
   虚拟化后未渲染元素的尺寸是估算值 → 居中会算错;影片库行高又可变(展开态含场次行)。
   本轮只上了 `content-visibility: auto`(仅抽屉列表行),理由与后续方案见 PLAN-20260911000705 §4。
8. **渲染层:网格 DOM diff 已落地**(2026-09-11,PLAN-20260911004000):
   网格改为「**几何签名不变 → 就地 patch 状态**」—— 点选 / 移出 / 改档位 / 冲突 / 紧转场 / 时间筛选 / 切方案
   都不再重建 DOM(浏览器实测:同一节点、自定义属性存活、`scrollLeft` 与页面滚动位置天然保持)。
   配套三件:① 徽章行按场次**模板 clone**(`legend.ts::metaRowFor`);② **订阅分域**(`state.ts::ChangeDomain`,
   `theme` 域跳过网格与抽屉重绘);③ 网格卡状态抽成纯函数 `cardStateOf()`(构建 / patch 共用一份,node 可单测)。
   ⚠ **仍未做**:完整虚拟滚动(见上条 —— `centerCardX` 依赖实测尺寸);`style.css` 的 `!important` 改 `@layer`
   (**已查明 Tailwind v4 层序是 `theme → base → components → utilities`,即 `components` 比 `utilities` 更弱 ——
   改过去只会更糟。那批 `!important` 是**正确**写法,勿动**);超长函数拆分(纯可维护性,无行为收益)。
9. **tailwind-merge 已评估并否决**(2026-09-11):实测成本 **gzip +9.7KB**(bundle 140.5→169.0KB / gzip 52.2→61.9KB,
   10 倍于「~1KB」的预估),而收益 **0** —— 全站 4 个共享工厂的 `extraCls` 参数**无任何调用点**真的传值。
   且它**解决不了** `style.css` 那批 `@utility` + `!important` 补丁(那是自定义 utility 与 Tailwind 生成类的
   **层序**问题,`in-plan` 这类自定义类名 tailwind-merge 并不识别)。→ 已撤,改用契约:
   `extraCls` 只放布局 / 变体,不覆盖字号 / 颜色 / 背景 / 圆角。详见 PLAN-20260911000705 §3。

---

## 1. 架构总览

**2026-09-13 起是 npm workspaces 三包**(`apps/*` + `packages/*`),不再是单页静态站。

```
离线管线(本机,非部署):Catalogue PDF → tools/extract_schedule.py → schedule.json / venues.json / films.json / douban.json(检入仓库)

Cloudflare(账号 62cbe67b…),两个 Worker:
  biff-scheduler(API + 公开入口,apps/api,有 D1 与 OAuth secret)
    ├ /api/*  → Hono 自己处理(登录 / 资料 / 同步)
    └ 其余    → service binding WEB 转发给 biff-scheduler-web
  biff-scheduler-web(纯静态资源,apps/web,**无 D1 / 无 secret**)
    └ dist/(Vite 产物):index.html + legacy/ + assets/ + 只读 JSON
        ├ schedule.json / venues.json / films.json
        └ douban.json / douban-related.json / douban-intros.json / festival-extras.json(均可为空,缺失静默降级)

D1 `biff-account-data`(**只存账号片单,不存排期**):
  festival_document(subject, edition='biff-2026', revision, records)  ← 每账号每届一份,revision 乐观锁
  account_import(subject PK)                                          ← 每账号只自动导入一次本机数据
  app_session / oauth_pending                                         ← 会话与 OAuth 中间态

浏览器 localStorage:
  biff.*(片单唯一源,见 §3)+ iffday.workspace.owner.v1 / iffday.workspace.cache.v1:<owner>
  → 访客**不上云**;登录后同步到**该账号自己的** festival_document,他人不可读
```

身份 = IFFDAY OIDC(`https://account.iff.day`),客户端 `biff-scheduler`;协议细节、会话与冲突处理见
`docs/account-integration.md`。

**前端模块**:`apps/web/src` 是 React 应用 —— `app/`(装配 + 路由 + store + 从 localStorage hydrate)｜
`components/`(ScreeningCard / ScreeningInfoPopover / ExportDialog / PosterPreview / FilmDialog / ScreeningMemberList …)｜
`pages/`｜`account.ts` / `account-sync.ts`(账号面板 + 同步引擎)｜`workspace-storage.ts`(写盘即广播同步事件);
**纯逻辑与视图工具**沿用旧版口径,仍在 `apps/web/src`:`state.ts` 全局 store + localStorage 持久化 + subscribe 订阅｜
`grid.ts` 排片网格｜`timeline.ts` **移动端单日纵向时间线**(≤768px 替换二维网格,`PLAN-20260912002532`)｜
`conflict.ts` 纯函数冲突检测｜`plans.ts` 顺位 + 冲突组 → 无冲突组合 / **逐层撞车检出** / **一键修复**｜
`score.ts` 行程质量分｜`ics.ts` 导出｜`gv.ts` 映后口径｜`badges.ts`/`legend.ts` 徽章与图例｜
`data.ts` JSON 加载(含豆瓣映射)｜`related.ts` / `intros.ts`｜`share.ts` 分享文案｜`poster.ts` 行程图｜
`types.ts` / `util.ts` / `units.ts` / `filters.ts` / `backup.ts` / `clipboard.ts` / `style.css`。
`apps/web/legacy/` = **旧版无框架实现,但仍在构建产物里**(`vite.config.ts` 的 rollup `input` 含
`legacy/index.html`,`App.tsx` 里有指向 `/legacy/` 的版本链接);`tests/legacy-snapshot.test.ts` 用 sha256
锁住它与 `8a95215` 快照一致 —— **是现场兜底的备用视图,不是死代码**;改共享口径时要留意两侧同步。

> 2026-09-10 结构收口(PLAN-20260910232833):`library.ts` 1784→928、`main.ts` 1137→786;
> 设置 / 抢票清单 / 质量分各自独立成文件;片名链 / 档位权重 / chip 类名 / 日期切段 / 时间标签收口到单一来源;补 `eslint` 门禁。
>
> 2026-09-10 适配与样式收敛(PLAN-20260910235000):**暗色跟随系统**(只覆盖 token)、
> ~~窄屏 ≤768px 列表优先~~(2026-09-12 二改为 **`timeline.ts` 单日纵向时间线**,见 §0 首条)、
> **字阶/圆角值命名阶梯真正生效**(全站 `text-[Npx]`/`rounded-[Npx]` 归零)、
> 按钮/tab/缩放控件类名收敛到 `ui.ts`、品牌红拆出 `text-biff-ink`(暗色下提亮,实底不变)。

---

## 2. 已拍板决策(勿反复;论证记录见归档)

| # | 决策 | 结论 |
|---|---|---|
| D1 | 前端形态 | Vite+TS 无框架;网格自研;FullCalendar 只用免费的都嫌重 → 行程=自研列表(**v1 偏差:未引 FullCalendar**,增 ~300KB 且样式难融) |
| D2 | 排期数据 | 静态 JSON(只读、版本化),**始终不落库**。D1 曾于 2026-09-11 整体退役(PLAN-20260911001107);2026-09-13 因账号同步**重新引入 D1**(`biff-account-data`),但**只存账号片单文档,不存排期** |
| D5 | 片单存储 | **访客只存 localStorage;登录 IFFDAY 后同步到该账号自己的云端文档**(2026-09-13)。旧口径「只存本地、云端 `user_pick` 整体退役」(2026-09-10,PLAN-20260910235630)针对的是**无账号时代的全局共享片单** —— 那时 `syncFromCloud` 云端为准 + 每次部署换 origin,导致已清掉的片单被同步回来;账号体系下每个用户读写的都是 `festival_document` 里**自己 `subject` 那一条**,他人不可读,原问题不复现。⚠ **仍然禁止**:未经登录就上传、或写入任何共享 / 非本人位置 |
| D6 | 豆瓣映射 | **只读静态 `public/douban.json`**(2026-09-11,PLAN-20260911001107):D1 `douban_map` + `/api/mapping*` + 页面粘贴回填全部退役;留空即走中英文搜索兜底 |
| D3 | 访问保护 | 无鉴权 + `noindex`;介意再加 PIN 门 |
| D4 | LLM 兜底/中文译名 | 在 WorkBuddy 对话代跑(零配置),不自备 API key |
| — | 外部组件库 | 全不引(§20 审核后维持):vis-timeline/FullCalendar/MapLibre/Lucide/组件库均否决,理由:排期固定不可拖 + 自研已深度定制 + 规模不需要 + 零重依赖 |
| — | Tailwind | ✅ 有条件采纳 = **v4 增量双轨**(2026-09-09 已接入):不引 preflight;存量语义类读 token、新 UI 用 utility;token 是唯一色源 |

**代码事实基线(改前必知)**:`conflict.ts` 的 `transitFor(a,b)` 已是注入函数 → Transit Matrix 只需数据层加查表,核心算法零改动。

---

## 3. 数据契约

**静态 JSON(排期侧无数据库)** —— 排期 / 场馆 / 目录 / 豆瓣映射一律只读静态文件;D1 曾于 2026-09-11 整体退役
(PLAN-20260911001107),2026-09-13 因账号同步重新引入,但**只存账号片单文档**(见本节末的「云端文档契约」):
```json
public/douban.json = {
  "mappings": {
    "<场次 code 或影片 f###>": {
      subject_id, title_cn, douban_url,          // 前端只读这三个(data.ts::loadDoubanMappings)
      title_en, year, rating, rating_count, confidence   // 审计字段;title_en 是 prune 的防撞号自证
    }
  }
}
```
- **生成**:`python3 tools/build_douban_map.py --films public/films.json --out public/douban.json`
  (豆瓣官方 API,见 `PLAN-20260911223200`);键**场次 code 与影片 id 都写** ——
  网格 / 行程 / 资料弹层按 code 查,「无排期目录片」按影片 id 查
- **只写 `high`**(片名命中 + 年份不矛盾);`miss` 一律不写,前端走中英文搜索兜底
- 条目**必须带 `title_en`**:`tools/prune_douban.py` 靠它判「换届撞号」并清掉失效映射
- 风控(`code 103/1005/1309`)时脚本**立即停轮并保留进度**,不把失败写成 `miss`

```json
public/douban-related.json = {
  "recs": { "<subject_id>": [ { id, title, year?, rating?, url } ] }
}
```
- **生成**:`python3 tools/build_douban_related.py`(对 `douban.json` 里每个 unique subject 拉
  `/recommendations`);「是不是本届」**不写进产物**,前端 `related.ts` 对照当前 mappings 现查
- 只存 movie;缺文件 / 该片无推荐 → 弹层不出现相关区(与 extras 同,增强不是运行前提)

**localStorage(访客片单唯一源;登录后镜像到云端)**:`biff.picks.v2` = `PickEntry[]`(`{key, picks:[{code}], note}` ——
旧数据的 `group`(方案 A/B)/ `priority`(档位)字段读取时忽略,**零迁移**);
另:`biff.settings.v1` / `biff.gvtalk.v1` / `biff.gvtalkmin.v1` / `biff.ranks.v1`(抢票顺位)/ `biff.agendafold.v1`。
**账号相关键刻意不在 `biff.*` 命名空间**(避免污染片单契约与备份导出):
`iffday.workspace.owner.v1`(当前 owner)/ `iffday.workspace.cache.v1:<owner>`(每账号一份 base/local 缓存)/
`iffday.workspace.import.v1:<owner>`(待导入的访客数据)/ `iffday.workspace.import-backup.v1:<owner>`。

**`biff.savedplans.v1`(已保存方案,2026-09-12)**:`SavedPlan[]` = `{id, name, codes, createdAt}` ——
`codes` = **第一顺位方案**的场次集合(每个冲突组取顺位 1 + 共同场次),**集合去重**(顺序无关),
自动命名「方案 N」;导出 / 分享按所选方案导出(见 §5)。⚠ 快照语义:行程之后怎么改都不动已保存方案。
旧 key `biff.plan.v1` 仅作一次性迁移源(只迁场次与备注,`biff.wish.v1` 的档位已随档位概念一起废弃),**迁移后即删**。

**云端文档契约(2026-09-13,`apps/api` + D1)**:服务端**不认 `biff.*` 字面 key**,只认四种前缀的扁平记录 ——
`pick:` / `plan:` / `local:biff.` / `raw:biff.`(见 `apps/api/src/index.ts::recordsSchema`);
`festival_document.records` 存该账号整份 JSON 快照,写入走 `revision` 乐观锁 + `operationId` 幂等,
单份序列化上限 **450 KiB**(超限 413)。前端 `sync-data.ts` 负责 `biff.*` ↔ 上述记录的映射与三方合并
(common ancestor / local / remote),冲突逐条让用户选保留哪版。**`account_import` 保证每账号只自动导入一次**,
且「写片单 + 标记已导入」在同一 D1 batch 内原子提交。

**schedule.json Screening**:`code / title_en / title_kr / title_zh / date / start_time / end_time / duration_min / venue_id / venue_display / is_gv / tags?`
- **GV/映后:解析阶段就 end_time = start + duration(+25min)**(保证 .ics 与冲突检测一致,前端不临时补)
- `tags?`:gv/masterclass/premiere/open_talk(见 badges.ts 注册表;未注册键静默忽略)

**venues.json**(2026):`id / name / name_kr / short / group / region / code` —— **26 厅**(id = 官方代码小写,如 `b1`/`c3`/`l10`;2026 **常规放映**无南浦洞厅,新增 Roof Theater `br` / Shinsegae `sc` / DSU-KIT `dk`。⚠ 别读成「本届没有南浦洞」—— Community BIFF(10/8–10/11)在南浦洞 BIFF 广场 / MEGABOX Busan Theater / Catholic Center Space 101.1,只是那批排期不在本数据集内)
**films.json**:250 部目录(unit 需按前缀归并:广角镜×3/Vision×2/Korean Cinema Today×2/亚洲电影人奖 2026~2029 四连脏数据 → 18 组;归并在 `app/model.ts::unitKey()`,旧版同名函数在 `legacy/src/library.ts`)

**festival-extras.json**(2026-09-11 新增):官网「排期之外」的辅助信息 —— **不是排期**,
时间 / 厅 / 片名仍以 `schedule.json` 为准,这里只补排期页不印的东西:
```jsonc
{
  "source": "https://www.biff.kr/eng/", "generated_at": "...",
  "ticketing": {
    "batches": [{ "includes": "Opening & Closing Ceremony / …", "openText": "Sep 17(Thu) 14:00 (KST)" }],
    "prices":  [{ "label": "Opening & Closing Ceremony", "krw": 30000 }],
    "discountKrw": 3000, "notes": ["…"], "callCenter": "1666-9177", "email": "cs@biff.kr",
    "bookingUrl": "https://ticket.biff.kr/",   // ★ 真正下单的站点;`url` 是官方购票说明页,两者不可混用
    "salesPeriod": { "period": "9.17 ~ 10.15", "hours": "24 Hours", "payment": "Credit card / Debit card" },
    "refund": { "deadline": "…up to 60 minutes before screening.", "howTo": ["…"],
                "fees": [{ "when": "6+ days before screening", "fee": "Free", "note": "" }], "notes": ["…"] },
    "discounts": [{ "who": "Accessible, Senior, Veterans", "terms": ["…"] }],
    "serviceDesk": { "location": "…", "eligible": "…", "screenings": "…", "notes": ["…"] },
    "url": "…page_num=11402"
  },
  "programs": [{ "code": "811", "kind": "master_class", "title": "…", "guest": "NA Hong-jin",
                 "guestZh": "罗泓轸", "dateText": "Oct 8 (Thu) 11:00 - 12:30", "priceKrw": 15000,
                 "language": "English, Korean", "venue": "…", "moderator": "", "bio": "…" }],
  "ceremony": { "openingDate": "Oct 6(Tue)", "closingDate": "Oct 15(Thu)",
                "slots": [{ "time": "18:00–19:00", "text": "Red Carpet Event" }],
                "traffic": [{ "window": "17:30–19:30", "road": "Suyeonggangbyeon-daero" }], "url": "…" }
}
```
- **生成**:`python3 tools/scrape_biff_extras.py`(抓 `page_num=11402/11218/11219/11366/11226/11223/11233`,
  `--offline` 复用 `data/_cache/extras/*.html`);过滤有**两道闸** —— ① 只保留 `schedule.json` 里真实存在的 code;
  ② `dateText` 的「月 日」必须落在展期内(`month_day_in_range`,展期从排期推导、不硬编码年份)。
  ⚠ **第 ② 道不能省**:官网节目页常年挂着往届条目,而编号会被下一届复用(实测 2025 的 Carte Blanche
  占了 2026 的 338 / 408)→ 只按 code 过滤时,去年的嘉宾会被挂到今年的场次上
- **票务字段来源**:`bookingUrl` / `email` **只存在于 HTML 的 `href` 里**,`page_lines` 已剥标签 → 必须回原始 HTML 取
  (取不到留空、前端自动隐藏,不编造链接);`discounts` / `refund` / `salesPeriod` / `serviceDesk` 用**正文锚点**定位 ——
  ⚠ 页内 `Online` / `Discount Policy` 会**先出现在表格列头与左侧菜单锚点**,`lines.index()` 取到的是那一处(实测解析为空),
  故分别改用「期段模式」与「下一行以 `Discount Amount` 开头」判定
- **开票时刻**:官网只印「月日 + KST 时分」(不带年)→ 前端 `extras.ts::ticketOpens(year)` 用 festival 年份组装;
  **同时给北京时间(KST−1h)与韩国时间** —— 官网印 KST、国内看 KST−1h,倒计时横幅两者并排
- **票价**:`extras.ts::priceOf()` 是唯一口径 —— **官网节目页优先**,其次按场次类型推断
  (开闭幕 30,000 / Midnight Passion 20,000 / Master Class·Actors' House 15,000 / 其余 10,000);
  放映后附带的 Special Talk / Carte Blanche 官网不印价 → `priceKrw: null` 走普通档(票就是那张放映票)
- **嘉宾中文名**:脚本内 `GUEST_ZH` 人工映射表(查不到只印英文名,不硬译)

**片名桥接(2026-09-11,已知缺口)**:官网排期给**英文名 + 韩文名**,目录给**中文名 + 原始名**,两者只重合约 **55%**(750 场中 412 场命中 `title_zh`)。对不上的场次 `title_zh` 留空 → 前端 `filmNodeKey` 归为「纯排期片」(不串片,但影片库会出现一对「中文条目无排期 + 英文条目有排期」)。补齐需一份双语别名表。
**片长**:官网排期页不印,按详情页回填;开闭幕式 / 获奖片重映 / 未编号场共 **9 条**用 120min 兜底(自检逐条点名)。

---

## 4. API

**2026-09-13 起有 API**(`apps/api`,Hono + Drizzle + D1),但**只有账号相关这一组**;
排期 / 场馆 / 目录 / 豆瓣映射**仍然是静态 JSON**(§3)——`/api/pick*`、`/api/mapping*`、`/api/plan*`
这些无账号时代的口子**没有回来,也不要加回来**。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | D1 连通性自检 |
| GET | `/api/auth/login` | 302 到 IFFDAY 授权端点(授权码 + PKCE S256;`?prompt=login` 强制重登) |
| GET | `/api/auth/callback` | 校验 state / nonce / issuer / audience / ID token 签名 → 建 `app_session` → 回 `/?account=connected` |
| GET | `/api/account/me` | 当前用户 `{user, profile}`;未登录 401 |
| PATCH | `/api/account/profile` | 改昵称 / 简介(`profile:write`,带 `expectedVersion`) |
| PUT / DELETE | `/api/account/avatar` | 头像(仅 `image/jpeg`) |
| POST | `/api/account/logout` | 删会话 + 撤销 refresh token |
| GET | `/api/account/sync/biff-2026` | 取本账号本届文档(`revision` / `records` / `importedAt`) |
| PUT | `/api/account/sync/biff-2026` | 提交整份记录(revision 乐观锁 + operationId 幂等) |
| POST | `/api/account/import` | 一次性把访客本机数据并入并标记 `account_import`(同一 D1 batch,原子) |

**两条硬约束(改前必读)**:

1. `/api/*` 有**同源 + Origin 校验**(`APP_ORIGIN` 白名单),写请求必须带同源 `Origin` 头。
2. `/api/account/*` 全部经鉴权中间件,**`subject` 一律取自会话,请求体里的 subject 与会话不符直接 409**
   —— 即**当前没有任何「读他人数据」的接口**。所以将来做影评 / 留言板 / 红黑榜这类 UGC,
   必须**新开一层公开读 API + 新表**,**不能复用 `festival_document`**
   (那是「单人整份文档 + revision 乐观锁」模型,与「多写者 + 聚合读」不同构)。

非 `/api/*` 的请求由 `apps/api/src/worker.ts` 转发给 `WEB` service binding(前端 Worker)。

---

## 5. 核心逻辑约定(易错点,改前必读)

- **顺位 = 偏好次序;方案 = 用户保存的快照**(2026-09-11 立;**2026-09-12 二改 —— 方案不再枚举**):
  冲突组 = 同一时间带互相重叠的几场的**连通分量**;组内拖动排序 = **抢票顺位**(只回答「先保哪一场」)。
  **方案不再是系统算出来的** —— 「保存当前方案」把**第一顺位方案**(每个冲突组取顺位 1 + 共同场次)
  存成快照(`biff.savedplans.v1`;场次集合去重、自动命名「方案 N」),导出 / 分享按所选方案导出
  (`export-panel.ts`)。顺位唯一用途 = 表达偏好次序 + 决定「第一顺位方案」是哪一套。
  **同一部片在一个方案里只出现一次**(2026-09-11 三改,`PLAN-20260911230500`)——
  行程里的同片多场是**抢票备选**,不是两个独立槽位。
  **顺位撞车**(2026-09-12):两个冲突组在**同一层**(各组第 k 场)撞到同一部片时,那一层的组合会被
  上一条剔除 ⇒ `plans.ts::detectRankClashes` **逐层**检出,行程顶部提示 + 逐组让路 +
  `autoFixRanks` 一键全部修复(带预览)。⚠ **只查对齐的层**,不查跨层同片(A 组顺位 1 与 B 组顺位 2
  同片属正常备选关系,不提示)。
  `plans.ts::buildPlanSet()` 仍产出 `options`(枚举全部无冲突组合)—— **UI 已不展示**,
  留着是因为 `broken`(「同一顺位内仍重叠」的异常证据)靠它逐套校验。
  ⚠ 边界:去重只作用在 picks 之间 —— 共同场次与某个 pick 同片时仍会重复,修它要先定义谁让路(未做)。
  选片 i 实际时段 = [start_i, end_i](end 已含 GV)
- 允许明知冲突强加,但始终视觉标红;`OK_SLACK = 15`(util.ts)为转场余量阈值,agenda 三态(gapNote ok/tight/bad)与 grid gap-bar 共用
- **顺位(抢票次序)是场次级**:`state.ts::rankOf: Map<code, number>`,独立键 `biff.ranks.v1`;
  每次拖完由 `setRanks()` 把该组整组归一成 1..n(只存相对次序,不存绝对值);场次移出行程后自动 prune
- **.ics 一律导出 UTC(Z)**,提醒用相对 TRIGGER(`-PT45M` 可改);UID = `<code>@biff-2026`;
  **导出 / 分享按所选方案**(2026-09-12)—— `.ics` / 分享文案 / 行程图都只含该方案的场次;
  没有已保存方案时导出项禁用(先「保存当前方案」)
- **导入分两类**(2026-09-12,同一弹层**按内容自动识别**):**备份 JSON**(`biff.*` 全量键 → 整体替换本机)
  / **`.ics` 排片**(只反解场次 `UID:<code>@biff-2026` → 合并或替换二选一,**默认合并**)。
  `.ics` 恢复不了备注 / 顺位 / 已保存方案 / 设置(格式里根本没有),见 `backup.ts` 文件头
- **存储分工(2026-09-11;2026-09-13 修订)**:**访客**片单(选片 / 排片)= 只存 localStorage,`commit()` 落盘即完成;
  **登录 IFFDAY 后**由 `account-sync.ts` 同步到该账号自己的 `festival_document`(见 §3 云端文档契约)。
  豆瓣映射 = 静态 `public/douban.json`(`loadMappings()` 在首渲前灌好);设置 / GV 覆写 = 本地。
  → **访客**清空片单后刷新 / 重新部署**不会复活**(旧版会从全局 `user_pick` 同步回来);
  ⚠ **登录状态下清空会同步到云端** —— 那是账号同步的预期行为(云端是本账号的副本),不是 bug。
- localStorage keys:`biff.picks.v2`(片单唯一源)/ `biff.settings.v1` / `biff.gvtalk.v1` / `biff.gvtalkmin.v1` /
  `biff.ranks.v1`(抢票顺位)/ `biff.savedplans.v1`(**已保存方案快照**,2026-09-12)/
  `biff.agendafold.v1`(行程按日收起)/ `biff.pickerw.v1`(抽屉宽度);
  `biff.plan.v1` / `biff.wish.v1` 是**一次性迁移源,迁移后即删**
- `douban.json` 缺失 / 为空 = 零映射:弹层与影片库走中英文搜索兜底(不是错误态)

---

## 6. 里程碑状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 脚手架+部署 | ✅ |
| M1 | 真数据管线(PDF→JSON) | ⏳ 等 9/11 官方 Catalogue PDF |
| M2 | 核心排片+导出 | ✅(mock 全链路;待真机验证) |
| M2.5 | ~~AI 排片~~(2026-09-11 已整体下线) | ❌ 已移除 |
| M3 | 增强:Transit Matrix/豆瓣批量回填 | ⏳ 部分(M3 剩余见 §7) |
| M4 | 账号体系(IFFDAY OIDC + 云端片单同步) | ✅(2026-09-13,见 §0 首条与 `docs/account-integration.md`) |

---

## 7. 待办清单(按优先级)

**7.1 M1 真数据管线(9/11 17:00 KST 排期发布后启动)**
- `tools/extract_schedule.py`:pdfplumber → Camelot(兜底)→ LLM 视觉残差页兜底;venue 别名归一;时间一律 KST
- venue 名单核对:删 mock 的 mega-haeundae(非官方 8 馆),补南浦 3 地点;8 馆 31 屏为准
- `validate_schedule.py` schema+冲突自检;`festival.dates` 已是真实 10/6–10/15 窗口(作日期条骨架,空档日占位待定)
- films.json 同片挂接:目录原始片名==排期英文名 / 中文名命中

**7.2 M3 剩余**
- Transit Matrix(P1-5):venues.json 增 `transit_min` 邻接对 + `data.ts transitFor(a,b)` 查表(未配对 fallback settings.transitMin);设置面板可编辑表格 —— conflict/engine 零改动
- **豆瓣映射续跑(2026-09-11 起,`PLAN-20260911223200`)**:`public/douban.json` 已落 **82 部 / 355 键**;
  剩 164 部等 IP 风控解除后续跑 —— `python3 tools/build_douban_map.py --films public/films.json --delay 3`
  (已完成的自动跳过,风控时脚本自己停),跑完 `git push` 一次即自动部署
- 豆瓣海报覆盖率(可选):`enrich_douban.py` 已切官方口(输出形状兼容,`fetch_posters.py` 不用改),
  重跑可把 156/246 往上提;但海报是**慢变量**,不阻塞

**7.3 真机手测残留(§19.3,代码已过 tsc+build)**
1. 网格 hover → 同冲突组 + agenda 联动高亮(反向亦然)
2. 紧邻跨馆场(003+004)→ gap-bar;设置缓冲 ≥15 后消失
3. 行程行内 必看/备选/随缘 三键即时切换
4. 「豆 x.x」徽章仅在有评分时出现
5. **窄屏单日时间线真机手测(2026-09-12,`PLAN-20260912002532`)**:手机竖屏打开即见时间线(不是影片库)、
   点卡选中 / 移出、相邻已选的重叠红条与间隔灰条、顶栏「列表 · 行程」↔ 面板内「◀ 时间线」往返、
   手机横屏(>768px)与竖屏来回切时「网格 ↔ 时间线」正确互换、`#picker-drawer` 全屏列表里的「定位 ▸」能回到时间线。
   (桌面回归已用无头断言覆盖:二维网格 / 缩放 / 挤压抽屉 / 限高 / 出口文案「收起 ✕」)

**7.4 P2 可选(不阻塞)**
- P2-7 冲突文案细分(kind: same-venue/cross-venue-overlap/transit)
- P2-8 自建 5 个内联 SVG(alert/check/x/chevron/info)替换 ⚠✓×▸ⓘ
- P2-9 视觉 5 件套微统一(Badge/Button/seg 三态、gap-bar/conf 读 status token、字阶收敛 --text-*)

**7.5 同场观影 & 场次讨论 的收尾(2026-09-14,`PLAN-20260914164050`)**
9. ✅ **`0005_screening_social.sql` 生产迁移已随 main 推送执行(2026-09-14 核实)**:`postbuild`
   (`scripts/prepare-cloudflare.mjs`,**仅** `WORKERS_CI_BRANCH=main`)在推送后自动跑迁移并部署前端。
   线上实测 `GET /api/stats/screening-counts?codes=008` → `200`(该接口依赖新表,证明迁移已生效),
   人数 / 讨论数不再是静默降级状态。
   ⚠ 迁移 `0006_screening_report.sql` 已随举报功能一并删除,本地 D1 里曾建出的 `screening_report`
   表也已 `DROP`;生产库**从未** apply 过 0006,故**无需**任何线上清理。
10. **无待办的人工步骤**(原「推送前必须配 `ADMIN_SUBJECTS` secret」已作废 —— 举报后台删除后这个
   secret 不再被任何代码读取)。若此前在 Cloudflare 或 `apps/api/.dev.vars` 里配过,可以顺手删掉:
   ```sh
   npx wrangler secret delete ADMIN_SUBJECTS -c apps/api/wrangler.jsonc
   ```
   不删也无害(没有任何代码读它)。「看到不良信息」的出口就是帖子上的「👎」。
11. ✅ **`e2e/react/screening-social.spec.ts` 已纳入 `git ls-files`**(随本轮提交入库):`scripts/affected-specs.mjs`
    靠 `git ls-files` 发现 spec —— 入库前它会被判成「映射里有磁盘上不存在的 spec」,入库后该提示消失,
    `docs/TEST-MAP.md` 里那条「⚠ `screening-social`(不存在)」的注记也随之消失(同一轮内已同步生成表格)。

---

## 8. 品牌素材与许可(重要,勿忘)

- `public/brand/`:favicon.ico / biff-mark.svg / biff-wordmark.svg / biff-2026-wordmark.png(顶栏在用)/ ft_logo.png(footer 在用)
- **个人非商业自用**前提;footer 保留"数据来自 biff.kr · 个人非商用"归属行
- **如转商业/对外大规模传播:立即移除 favicon.ico、biff-mark.svg、ft_logo.png 三件并换自有设计**

---

## 9. 风险与避坑(仍生效)

1. FullCalendar Resource 视图付费 → 网格已自研,别回退
2. **部署口径(2026-09-11 修正):线上 = https://biff.lcandy.co(Cloudflare Workers 静态资源,CF 账号 `62cbe67b…`),
   `git push origin main` → Workers Builds 自动构建上线**。
   ⚠ **别再 `wrangler pages deploy` 直传** —— 旧 Pages 项目 `biff-scheduler.pages.dev`(账号 `c591765d…`,本机 wrangler 默认登录的那个)
   **已不在访问链路上**,传上去没人访问;本机 `npm run deploy`(= `wrangler deploy`)也会因「账号里没这个 Worker」而失败。
   判别谁在服务:Pages 的 HTML 响应带 `access-control-allow-origin` / `referrer-policy` / `content-type: text/html; charset=utf-8`,
   Workers 静态资源三者都没有(只有 `content-type: text/html` + `cf-cache-status`)
3. ~~D1 已退役(2026-09-11)~~ **已于 2026-09-13 部分回退**:账号同步重新引入 D1(`biff-account-data`,**仅存账号片单**);
   迁移走 `npm run db:migrate:remote`(生产只在 `main` 分支构建里自动执行),**不要**对生产跑 `drizzle-kit push`。
   ~~`d1 execute --command` 只跑第一条 SQL~~ / ~~本地调试别传 `--d1`~~ 两条仍作废
4. 豆瓣**网页口**必撞 CAPTCHA / 静默限流 → 已改用**官方 Frodo 口**离线回填(`tools/frodo_client.py` +
   `douban_match.py`,见 `PLAN-20260911223200`);前端仍只做链接跳转(浏览器设不了 UA + 跨域被拦 + 密钥会外泄)。
   ⚠ **接口风控两处**:`search/subjects` 跑约 100 次即 `403 need_login`(**登录流程未恢复,别用这个口**);
   详情口也会 `code=1309 subject_ip_rate_limit`。风控期间**检索仍返回 200**,极易被误记成「豆瓣没有这部片」
   → `douban_match.py` 命中 `{103,1005,1309}` 一律抛错停轮,`build_douban_map.py` 已按此处理,勿改成「记 miss 继续」
5. **GV 时长在解析阶段 +25min,别在前端临时补**(保证 .ics 与冲突一致)

---

## 10. 文档地图

| 文件 | 用途 |
|---|---|
| `PLAN.md`(本文件) | 当前状态/决策/待办/架构 —— **每轮开发先读这里,完成后更新 §0/§6/§7** |
| `AGENTS.md` | 规范**入口**(受版本控制,对所有协作者与 AI 生效);`.codebuddy/rules/…/RULE.mdc` 是本机自动加载的等价副本 |
| `docs/DEVELOPMENT-STANDARDS.md` | 规范**完整版**(含论证与范例);与 `CONVENTIONS.md` 冲突时以它为准 |
| `docs/CONVENTIONS.md` | 具体口径细节(弹层 / 渲染 / 数据契约 / 踩坑) |
| `docs/TEST-MAP.md` | **改动路径 → 必跑 spec**(机读源 `scripts/test-map.json`);`npm run specs:affected` 按 diff 输出 |
| `docs/legacy-retirement.md` | `/legacy/` 的冻结条款、退役判据与 8 步退役清单 |
| `docs/account-integration.md` | IFFDAY 账号接入:OIDC 流程 / 会话 / 云端同步与冲突 / Cloudflare 配置 / 本地联调 |
| `skills/` | 可复用能力(无头验收 / PDF 管线 / 并行安全提交 / Tailwind 产物核对 / 部署) |
| `docs/history/2026-09-09-开发落地记录.md` | §10~§20 全部历史轮次(视觉对齐/影片库/AI 排片/样式重构等)+ plans 执行蓝本附录;只读查询,不再追加 |
| `data/` `tools/` | 离线管线脚本与产物(本地,不部署) |

> 维护纪律:新轮次的"落地记录"要么并入本文档对应章节、要么追加到 `docs/history/` 按日期建新文件 —— 不要在本文档堆砌一次性流水账。
