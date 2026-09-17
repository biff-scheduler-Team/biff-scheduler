# BIFF 排片工具(BIFF Scheduler)— 项目活文档

> 定位:自用釜山电影节排片工具 —— 解析官方 Ticket Catalogue → 可视化选片排期 → 冲突检测 → 导出 .ics → 一键跳豆瓣。
> 栈:Cloudflare Workers(线上 = https://biff.lcandy.co,推 main 自动部署;2026-09-13 起是**两个 Worker** ——
> API `biff-scheduler` + 静态资源 `biff-scheduler-web`)+ React / Router / Spectrum S2 + Vite + TS
> + Tailwind v4(增量双轨)+ 静态 JSON + D1(**仅存账号片单**)。
> **本文档 = 当前状态 + 决策 + 待办 + 架构(活文档)。历史轮次记录已归档至 `docs/history/`,不要再往回写流水账。**
> 最后更新:2026-09-17(**底部 Toast 补上默认自动收起** —— React 版直接 re-export 了 S2 的 `ToastQueue`,
> 而 S2 只在**显式传了 `timeout`** 时才自动关闭(`addToast`:`options.timeout && !options.actionLabel …`),
> 旧版是 3600ms 自动收(`legacy/src/toast.ts`)。于是全仓 30+ 处漏写 `timeout` 的调用(加入选片 /
> 发布建议 / 删除留言…)触发一次就永久钉在屏幕底部。现收口到 `components/toast.ts` 一层包装兜底 5000ms
> (S2 的下限,写更小也会被 `Math.max` 抬上去),调用点零改动、显式 `timeout` 仍可覆盖。
> 见 `PLAN-20260917095716`);
> 上一轮 2026-09-17(**豆瓣映射取用口径收成一处** —— 外跳 href 早就是单一实现 `doubanUrlOf`,
> 但「先取哪条映射」在 6 处各写了一份:只有影片库卡与影片资料弹层带「退目录片 `f###`」这条腿,
> 同一部片于是「影片库能直达条目页、行程卡却掉进搜索结果页」。现收口到 `util.ts::doubanMappingOf`
> (有场次按 code → 未命中退 `f###` → 都没有则交 `doubanUrlOf` 搜);公开排期行为不变,
> P&I 那 30 场的「豆瓣 ↗」顺带从搜索页变条目页。另补 `parity-dialogs.spec.ts` 缺的 `showPni` 夹具
> (`0d68da7` 起就在 main 上红)。见 `PLAN-20260917010426`);
> 上一轮 2026-09-17(**页面私有查询参数不跨页** —— `q` 在影片库 / 红黑榜 / 吃喝三页各有一份语义,
> 主导航却把整条 search 原样搬到每个导航链接上,于是「影片库搜 Midnight Passion」切到吃喝时,
> 吃喝的搜索框里躺着同一句话、清单被同一根 needle 滤成空(中文词在吃喝必然 0 命中)。
> 现收口到唯一口径 `apps/web/src/app/nav-query.ts`:同名 key 只在自己页面上成立,
> 跨页只保留排片表的 `date` / `hour`;顺带补上 `screening-social.spec.ts` 漏改的导航顺序快照
> (「吃喝」上线时它就已在 main 上红)。见 `PLAN-20260917002528`);
> 上一轮 2026-09-16(**登录失败再深一层:上游错误码 + 本步耗时可见** —— 上一轮把失败**步骤**变成
> 可见的码后,用户拿到 `token_rejected`(「账号系统拒绝发放登录凭证」),并追问「是不是超时太短了」。
> 实测发现答案拿不到:`describeError` 只落在 **Worker 侧**日志(CF 控制台,本机与用户都读不到);
> 现已把**上游 OAuth error 码**(白名单 `^[a-z_]{1,32}$`,绝不回传响应体)与**失败那一步自己的耗时**
> 一并回传(`?account_error=<步骤>:<细节>&account_ms=<ms>`),`network_timeout` 与 `invalid_grant`
> 的分界就是「我们主动放弃」与「上游明确拒绝」的判据。同时纠正 `IDENTITY_TIMEOUT_MS` 的注释口径:
> 实测有一次 4.39s 的成功请求,但混了 D1 耗时,**尚未坐实该 3 秒上限是否真的能中断**
> —— 所以在拿到 `account_ms` 之前不动任何超时数值。见 `PLAN-20260916220942`;
> **同日追加(修订 1,用户要求):登录流程的上游预算改为 10 秒** —— 新增
> `AUTH_FLOW_TIMEOUT_MS`,只给 `/api/auth/login` + `/api/auth/callback`(单次上限 10 秒 +
> 整条流程共享一个 deadline);**共享的那 3 秒一个字没动** —— 它被刷新链路的租约不变量绑着
> (`REFRESH_LEASE_MS >= 2 × IDENTITY_TIMEOUT_MS`),直接调大等于让并发刷新拿同一个 refresh token
> 去换、上游撤销整个 token family。这条已写成断言,把它改成 10_000 会立刻红 3 条;
> 上一轮(**登录失败病因可见** —— callback 的 7 条失败路径原先有 6 条都塌成同一个
> `account_error=authorization`,前端又把 `account_error` 的具体值丢掉,于是线上「点登录 → 跳回首页
> 提示登录未完成」**没有任何可观察手段**(CF 日志 / D1 本机都够不着);现按**步骤**分诊成 13 个码,
> 唯一口径放进共享契约 `loginFailureCodeSchema`,回调抽成 `auth-callback.ts`(可单测),
> `/api/auth/login` 也不再抛 500 而是回同名码;前端 `account-errors.ts` 用
> `Record<LoginFailureCode, string>` 保证漏写文案即编译不过,toast / 账号面板 / 控制台三处都带上原因与原始码。
> **本轮以「病因坐实到具体一步」结案,不以「已修复」结案**(用户重试一次即可读出具体码),见 `PLAN-20260916215100`;
> 上一轮(**P&I 记者 / 业界场录入 + 显示开关** —— 册子排期页 BD(Indieplus)/ CGV 7
> 两列共 37 场原先整批跳过(不印场次编号、不对外售票),现单独收口到 `apps/web/public/pni.json`,
> **公开 `schedule.json` / `venues.json` 一个字节不变**(哨兵照旧);前端在 catalog 里带一份,
> 默认**不显示**,只在「设置 → 场次范围 → 显示 P&I 场次」勾选后才并进排期表 / 片单 / 行程 / 冲突 / 导出。
> 见 `PLAN-20260916182254`;
> 上一轮(**讨论区页头可直接按场次发帖** —— `/discussions` 原先只有「定位条发帖」与
> 「点格子的『进入讨论』」两个入口,两个都要求场次已知(一个来自 `focus`、一个要求那一场已有帖子);
> 现补**常驻发帖口**:页头按钮内联展开场次检索(官方编号 / 片名),选中后开**同一个**
> `ScreeningDiscussionDialog`,发完立刻落方格墙首位。检索口径提取为 `app/schedule-search.ts`,
> 与「添加转票场次」共用一份;选择区刻意不做成弹层(两层 modal 交接的焦点归还不可靠)。见 `PLAN-20260916154255`;
> 上一轮(**活动场次补中文名** —— Actors' House / Master Class / Cine Class / Special Talk
> 共 17 场原先只有英文名(这批在影片目录里没有条目,抓取脚本的目录反查必然落空,`title_zh` 恒空),
> 现由人工表 `data/event-titles-2026.json` 补译名,`scrape_biff_web.py --event-titles` 与
> `tools/apply_event_titles.py` 共用同一份匹配(不各写一套);配套把 `filmNodeKey` 的 `sched:` 口径改为
> **以官方英文名为准** —— 原口径 `title_zh || title_en` 会让「补译名」顺手改掉身份 key,
> 使 `biff.picks.v2` 里已选记录静默失配,见 `PLAN-20260916142713`;
> 上一轮(**导出范围可切「当前行程」** —— 「导出与分享」的下拉从 `导出方案` 扩为 `导出范围`,
> **默认选中「当前行程」**(与 `/rush` 同源:同一份行程 + 同一份顺位 / 批次;勾上顺位 + 批次后分享的两节
> 与 `/rush` **逐条一致**),已保存方案仍可显式选;场次取自所选范围,而**顺位 / 备选 / 批次一律取当前行程**
> —— 旧版把两者混用,会出现「方案里的 `222` 印成主选、当前第一顺位 `805` 反倒印成『222 的主选』」这种
> 自相矛盾的清单,见 `PLAN-20260916135942`;
> 上一轮(**红黑榜接入用户共享** —— 新增两张 D1 表 + `/api/stats/film-votes`(-ping),
> **一人一部一票、不做加权**(与「想看人数」的 0.75/1.0 刻意不同),榜单排序 / 评分 / 卡片数字改读全体票数;
> 本地贴纸只代表「我」,别人的票画成只读小点;**同日修订 8 删掉了「示例铺底」** ——
> 红黑榜正式环境从**空榜**开始,老用户本机已铺出去的示例由 `purgeDemoLeavings()` 一次性收干净,
> 见 `PLAN-20260916102339` 修订 7 / 修订 8 / 修订 9(评分改为**单部**,顶部的全局评分已删);
> 上一轮:**讨论区定位条可直接发帖** —— `/discussions?focus=<场次 code>` 的定位条新增「发帖」入口,
> 打开既有的 `ScreeningDiscussionDialog`(某场**一条帖子都没有**时也能发首帖),发布后新帖立刻插到方格墙首位,
> 见 `PLAN-20260916102631`;
> 上一轮:**备选按自己的开票批次归节** —— 分享文案 / 分享图片里与主选**不同批次**的
> 备选抬成独立块(行首 `↳ `、顺位印「349 的备选②」)归自己的批次节,抢票当天按节扫才不会漏;
> 同批次的备选仍紧跟主选,见 `PLAN-20260916011511`;
> 再上一轮:**抢票页去重** —— 「抢票」不再复用行程页的场次卡,改为一行一场的紧凑清单
> (CODE / 时间 / 日期 / 片名 / 影院 / 顺位,只留票务三态),并删掉页内重复的倒计时与批次品类说明,
> 见 `PLAN-20260916005951`;
> 更早:**测试职责移到云端** —— 删掉本地 `pre-push` 门禁:Cloudflare 构建挡部署、
> GitHub CI 跑 E2E,本地不再跑门禁,见 `PLAN-20260916003228`;
> 再早:**分享文案改版** —— 两行一场 → 三行缩进块(续行与片名左对齐),去掉全部 emoji,
> 顺位标记改「主选 / 备选②」、GV 文案「含映后谈」→「映后」,见 `PLAN-20260916002752`;
> 早先:**抢票** —— 新增顶层模块 `/rush`:行程场次按开票批次分组 + 倒计时;分享文案 CODE 提到行首,
> 新增两个勾选「带上顺位(含备选场次)」/「带上开票批次」,见 `PLAN-20260915234414`;
> **2026-09-16 修订 2**:分享图片也吃同一份 `ShareOptions`(图上画「主选 / 备选②」与备选行、按开票批次分节,
> 行首改 `CODE  时间`),与上面那条同属 `PLAN-20260915234414`;
> **讨论区** —— 讨论集合搬进顶层模块 `/discussions` 的方格墙,行程里的「讨论 N」改为跳过去定位,
> 见 `PLAN-20260915233816`;影片库单元归属 = 主单元 ∪ 联映块单元,见 `PLAN-20260915144335`);
> 更早的轮次**不再逐条罗列** —— 见 §0 已完成快照(一行一条)与各自的 `docs/plans/PLAN-*.md`。

---

## 0. 当前状态快照(2026-09-14)

**✅ 已完成(一行一条;细节见各自的 `docs/plans/PLAN-*.md`)**

> 本节**只减不增** —— 新需求只写独立 PLAN 文件,`PLAN.md` 只在文档头更新一行「最后更新」(见 `AGENTS.md` §1)。

- **「已保存方案」的「查看场次」改弹层**(2026-09-14,`PLAN-20260914213000`) —— 内容复用 `poster.ts::buildPosterModel`,与分享图片同源;`describeSavedPlan` 与 hover tooltip 保留不动。
- **修顺位拖拽判定坐标随页面滚动错位 + 冻结午夜边界用例时钟**(2026-09-14,`PLAN-20260914205901`) —— 判定改用「相对容器顶」局部坐标;`clock.install` 后补 `pauseAt`。
- **排期数据更新提示**(2026-09-14,`PLAN-20260914192552`) —— 顶栏「数据更新」+ `tools/build_changelog.py` → `changelog.json`;影片身份走 `filmNodeKey()`;新键 `biff.dataver.v1`;不自动弹窗。
- **官方付印册子并入产物**(2026-09-14,`PLAN-20260914184902`) —— `tools/merge_schedule.py` 让 `schedule.json` 750 → 830 场(补 MEGABOX 1–4 / 官方编号 901–942);册子 BD / C7 两列是 P&I 场次,**不进公开排期**;册子影片介绍页 → `FilmItem.catalogue`(244 部)。
- **修 `sessionFor` 刷新把健康会话打成 401**(2026-09-14,`PLAN-20260914181918`) —— 改条件删除 / 条件释放租约 / 检查 `changes` / 等待窗口对齐租约 + 上游 service binding 硬超时;⚠ 上游真消费掉 RT 的情况不可自愈,只能重新登录。
- **同场观影 & 场次讨论**(2026-09-14,`PLAN-20260914164050`) —— `biff.tickets.v1` 票务三态 + 转票 + 「仅看实际行程」;同场人数 = 该场出现在多少人的行程里(**不看票务状态**,只回聚合数字);D1 新表 `screening_post` / `screening_reaction`。
- **同场观影 & 场次讨论 · 追加:社区约定 / 免责 + 点踩**(2026-09-14,同上 PLAN 修订 1·2·3) —— 负反馈只做 `👎`(与其它反应同一条 toggle 路径);**举报 + 管理员后台整体移除**(`0006` / `ADMIN_SUBJECTS` / `requireAdmin` / `/admin` 全删);修订 3 起**提醒只留一条可关闭的**(删掉常驻的「发布前请阅读」),且语气由「规定」改为「建议 / 劝阻」。
- **Umami 分析接入**(2026-09-14,`PLAN-20260914160700`) —— 只在 `index.html`(含 legacy)挂一次,靠 History API 自动 pageview;`data-domains` 限 `biff.lcandy.co,biff.iff.day`。
- **对齐 BIFF 官网口径:修 4 处错 + 补票务信息**(2026-09-14,`PLAN-20260914143817`) —— 购票入口 `ticket.biff.kr`、取消与退款三档、折扣年龄口径订正为「**1961 年及以前出生**」;官网两处自相矛盾按「节目页 > newsletter」定夺。
- **素香剧场分区口径修正 + 新版残留清理**(2026-09-14,`PLAN-20260914141643`) —— 错的只有 `legacy/src/legend.ts`(`sohyang` / `bcm` 误归 nampo);新版 `FilterBar` 的「南浦洞」改为按数据渲染(`filters.ts::regionPresets`)。
- **建议反馈留言板**(2026-09-14,`PLAN-20260914134700`,走 PR) —— `/feedback` 公开可读、登录后发帖 + 五类 emoji;D1 `feedback_post` / `feedback_reaction`。
- **规范补两条:大改动走 PR + 大重构前打 checkpoint**(2026-09-14,`PLAN-20260914101945`) —— §4.5 / §4.6;checkpoint **不能替代原子提交**。
- **双前端账号一体 + 桌面 1:3 分栏 + 想看人数加权**(2026-09-14,`PLAN-20260914003600`) —— Legacy 薄登录/同步桥(共享 cookie + `biff.*`);工作台 max-width 1600px;D1 `film_want_*`(登录 1.0 / 匿名 0.75)。
- **main E2E 大面积失败修复**(2026-09-13,`PLAN-20260913225149`) —— 根因是测试未跟 UI 演进(标题含年月 / `iffday.workspace.*` guest 缓存 / `?quick=1` / 三档缩放 / GV 文案);helpers 排除 `iffday.*`。
- **IFFDAY 账号体系 + 前后端分仓**(2026-09-13,`cbead95` / `8a54eca` / `26b21e0`) —— npm workspaces 三包;OIDC 授权码 + PKCE S256;cookie 只存随机 token;片单**登录后**才同步到该账号自己的 D1 文档(乐观锁 + operationId 幂等)。详见 `docs/account-integration.md`。
- **豆瓣入口落在「片名右侧」**(2026-09-13,`PLAN-20260913184357`) —— 影片卡与行程卡**两处片名行都给入口**,共用 `.title-row` / `.douban-jump`;入口一律在标题标签之外。
- **把「靠人记住的规范」改成「机器能挡的闸门」**(2026-09-13,`PLAN-20260913201727`) —— CI + `check-repo.mjs` + api 单测 + `TEST-MAP` + git hooks + legacy 退役计划 + Dependabot 七项;草稿落点定为工具中立的 `.scratch/`。
- **规范新增「§9 与 AI 协作的约定」**(2026-09-13,`PLAN-20260913201058`) —— 需求怎么提 / 变更怎么记 / 交付物长什么样;原「变更记录」顺延为 §10。
- **「在 Google 地图打开 ↗」贴住影院地名**(2026-09-13,`PLAN-20260913192048`) —— 去掉 `.venue-map-link` 的 `margin-left: auto`(改前实测间距 878px)。
- **移除行程最后一场不再连带删掉选片**(2026-09-13,`PLAN-20260913180837`) —— `picks` 为空 = 合法的「已选未排场」态;要真删走显式的「移除影片」。
- **TMDB 海报**(2026-09-12,`PLAN-20260912213000`) —— token 只读环境变量 `TMDB_KEY`;`films.json` 海报 156 → 228。
- **排片表 / 时间线海报与评分 + 详情简介**(2026-09-12,`PLAN-20260912204312`) —— 网格卡横向 `[海报 | 正文]`;简介产物 `public/douban-intros.json`。
- **豆瓣相关电影**(2026-09-12,`PLAN-20260912195707`) —— `public/douban-related.json`(220 subject);弹层加「本届也在放」与「豆瓣也推荐」;文件缺失静默降级。
- **导入支持 .ics + 已保存方案改横向**(2026-09-12) —— 按内容自动识别 `.ics` / 备份 JSON;`.ics` 只恢复场次,默认合并;方案卡固定 212px 横向流。
- **顺位撞车(逐层)+ 一键修复 · 保存方案 · 按方案导出**(2026-09-12) —— 方案从「系统枚举的对比列表」改为「用户手动存的快照」(`biff.savedplans.v1`);原「方案对比 · N 套」枚举区下线。
- **移动端极端适配**(2026-09-12,`PLAN-20260912002532`) —— 窄屏改**单日纵向时间线**(`src/timeline.ts`),抽屉降为次级视图;**PC 端零影响是硬约束**。
- **页脚贡献者署名**(2026-09-12,`PLAN-20260912001500`) —— 两个贡献者 GitHub 外链;样式零新增。
- **抢票信息 + 节目嘉宾 + 开闭幕式**(2026-09-11) —— `tools/scrape_biff_extras.py` → `public/festival-extras.json`;顶栏开票倒计时同时给北京 / 韩国时间;**数据缺失一律静默降级**。
- **部署口径修正**(2026-09-11,`PLAN-20260911233000`) —— 线上 = `https://biff.lcandy.co`(Workers 静态资源,CF 账号 `62cbe67b…`),推 `main` 自动部署;`wrangler pages deploy` / `npm run deploy` 作废。
- **分享图片(行程图)**(2026-09-11,`PLAN-20260911231000`) —— `src/poster.ts`(模型 + canvas 绘制)与 `poster-panel.ts`(预览弹层)分层,**手绘 canvas、零依赖**。
- **数据备份 / 迁移**(2026-09-11) —— `backup.ts` 按 `biff.` 前缀快照**全部**本机键(不写死键清单);纯逻辑与 DOM 分层。
- **豆瓣官方 API 接入**(2026-09-11,`PLAN-20260911223200`) —— `tools/frodo_client.py` + `douban_match.py` + `build_douban_map.py`;`{103,1005,1309}` 定为风控码,命中即**停轮保进度**(不得把失败写成「没有这部片」)。
- **方案对比:同一部片只留一场**(2026-09-11,`PLAN-20260911230500`) —— 同片多场不再算两个独立槽位;兜底 = 全判死时退回不去重结果。
- **拖动顺位 = N 套方案 + 删除档位**(2026-09-11,`PLAN-20260911223000`) —— 冲突组顺位卡可拖动排序,顺序即抢票顺位;档位(必看 / 备选 / 随缘)整体删除(`src/pick.ts`)。
- **日期口径统一 + 选片日期多选**(2026-09-11,`PLAN-20260911213952`) —— 全站日期一律印官方写法 **`OCT 8`**;选片日期筛选由单选改多选。
- **片名口径 = 「英文名 · 中文名」**(2026-09-11,`PLAN-20260911172000`) —— 统一由 `util.ts::bilingualTitle` 产出。
- **数据届次 = 2026 第 31 届**(2026-09-11 切换) —— 750 场 / 26 厅 / 10 天(10/6–10/15);影片目录 = 官方 xlsx → 250 部。
- **排片筛选**(2026-09-11) —— 字幕 / 影厅 / GV 过滤(多选 + 三态单选,**只淡出不隐藏**);网格与影片库共用 `src/filters.ts`。
- **海报**(2026-09-11) —— `films.json` 的 `poster` 对齐 `public/posters/` 本地图(174/250)。
- **脚手架**(2026-09-10–11) —— Vite + TS(2026-09-13 起前端为 React,旧的无框架版仍在 `apps/web/legacy/` 且仍在产物里);部署目录 `dist/`。
- **核心排片**(2026-09-10–11) —— 自研 CSS Grid 网格(影院×时间)、点选加入行程、时间重叠红标 + 跨行连线。
- **行程视图**(2026-09-10–11) —— 自研议程列表(按日分组;冲突组折叠成绿框顺位卡)—— 不用 FullCalendar(见 §2 决策)。
- **导出**(2026-09-10–11) —— `.ics`(UTC、GV 场次时长已含 +25min);分享文案复制。
- **影片库**(2026-09-10–11) —— `films.json` 250 部目录,搜索(中/英/code/导演/单元)+ 单元 chips + 反向定位。
- **豆瓣**(2026-09-10–11) —— 静态映射(`public/douban.json`,离线产物)+ 中英文搜索兜底;不做爬虫。
- **M2.5 智能排片已下线**(2026-09-11) —— `ai.ts` / `ai-panel.ts` / `ai-prompt.ts` 与 `biff.ai*` 键、设置项、单测全部移除;`engine.ts` 更名 `score.ts`,仅保留行程质量分。
- **视觉**(2026-09-10–11) —— BIFF 黑白红风对齐(官方抓取 `#ce1e36`)+ Design Token 分层 + Tailwind v4 增量接入。
- **品牌素材接入**(2026-09-10–11) —— `brand/` 的 wordmark / favicon / footer,含许可约束(见 §8)。
- **排片表字段徽章 + 图例总览**(2026-09-10–11) —— `legend.ts` 单源(等级 / 字幕 / 节目册页码 / 片长),每枚 `data-tip` 即时说明。
- **网格卡选中态改「底色交互」**(2026-09-10–11) —— 去掉左侧优先级竖条,改整卡 `color-mix(--pc 14%, card)` 淡底色。
- **存储与适配**(2026-09-10,`PLAN-20260910235630` / `PLAN-20260910235000`) —— 片单(选片 / 排片)**只存 localStorage**;暗色跟随系统;字阶 / 圆角值命名 token。
- **零后端**(2026-09-11,`PLAN-20260911001107`) —— ⚠ **该状态已于 2026-09-13 部分回退**:账号同步重新引入 D1(`biff-account-data`)与 `/api/account/*`,但豆瓣映射 / 排期**仍是静态 JSON**,`/api/mapping*` 与 `functions/` 没有回来(见 §4)。
- **工程化**(2026-09-11,`PLAN-20260911000705`) —— PWA(预缓存产物 + 只读 JSON → 现场断网可用)+ Vitest 单测接入 `build` 门禁;`ui.ts::extraCls` 确立为**布局 / 变体专用**契约。
- **全量审查后的优化轮**(2026-09-11,`PLAN-20260911004000`) —— `.ics` RFC5545 转义 + 按 UTF-8 字节折叠;弹层 `role=dialog` / focus trap / 焦点归还;`slackBetween()` 收敛转场余量判定。
- **渲染层重构**(2026-09-11,`PLAN-20260911004000` §3.1) —— 「几何签名不变 → 就地 patch」;`cardStateOf()` 纯函数(构建 / patch 共用);订阅分域 `ChangeDomain`。

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
| `PLAN.md`(本文件) | 当前状态/决策/待办/架构 —— 每轮开发**按需读章节**;**新需求不回写 §0**,只在文档头更新一行「最后更新」 |
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
