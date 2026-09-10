# biff-scheduler 工程约定

> 从 `.workbuddy/memory/MEMORY.md` 拆出(该文件有 3,000 字上限)。**改代码前先读这份**。
> 关联 SKILL:仓库内 **`.codebuddy/skills/biff-catalogue-pdf-to-schedule/`**(PDF→JSON)、
> 用户级 `parallel-agent-safe-commit`(并行提交)、`web-ui-headless-interaction-qa`(无头交互验收)、
> `tailwind-v4-built-css-verify`(产物类名核对)。

## 一、工作流与协作纪律

- **需求四步**:① 独立 PLAN `docs/plans/PLAN-<YYYYMMDDHHMMSS>.md`(只读本需求的 PLAN,不整读 PLAN.md 活文档)
  → ② 实现 → ③ `git add`+commit+push → ④ `npm run deploy`(Cloudflare Pages production)。
- **本地服务克制**:排查/改代码直接读代码,**不要**为「看效果」起 dev server 或浏览器;确需验证才起最小必要服务,用完即停。
- **git 签名(1Password SSH)**:`commit.gpgsign=true` + `gpg.format=ssh` + `op-ssh-sign`。
  先 `export SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"`。
  **两种报错含义不同**:沙箱内 `failed to fill whole buffer` = 没跑出沙箱;加 `dangerouslyDisableSandbox` 后
  `agent refused operation` = 1Password 锁定,让用户解锁。`ssh-add -l` 能列 key 不代表能签名。
  **commit/push 一律在沙箱外跑。**
- **同文件多处改动必须串行 Edit**:并行发多个 Edit 会互相覆盖且**每个都报 success**(曾静默丢 3 处改动)。改完必须 `npm run typecheck`。
- **Bash 的 `grep`/`rg` 会被拦并静默返回空** → 检索一律用 `Grep` 工具。确需 Bash grep **必须带 `-E`**(不带 `-E` 的 BRE 交替会静默返回空 + exit 1)。
  命令里含 `ps`/`reg`/`sc`/`wmic` 之类 token 会被判「系统级工具」拦掉 → 写临时 `.py` 文件跑。
- **多会话并行提交纪律**:提交/部署前先确认「静默」
  (`date` + `stat -f '%Sm %N' -t '%H:%M:%S' index.html src/*.ts docs/plans/*.md`;`git log --oneline -1` 比对 HEAD)。
  连续 90 秒无新写入再动手。对方已 commit+push+deploy 同一内容 → 不重复提交。
- **只提交自己 hunk 的标准手法**:完整配方见 SKILL **`parallel-agent-safe-commit`**。两条实测坑:
  ① **对方 commit 会把你在途改动一起卷走**(症状:你的文件在 `git status` 变 clean、`git diff HEAD` 只剩尾巴)
  → 提交前 `git show HEAD:<file> | grep <自己的标记>` 判断是否已被带上,别重复提交;
  ② **对方 commit 可能漏配套文件**(实测 `pick.ts` 用 `bg-pri-*-soft`,而 `--pri-*-soft` token 只在未提交的 `style.css`
  → 从 HEAD 构建静默丢类)→ 自己的改动落在配套文件里就**整个文件带上**,并在 commit message + 回复里说明多带哪几行。
- **部署范围**:`npm run deploy` = `vite build`(读磁盘) + 上传 → 工作区任何在途改动都会上线。
  有并行在途改动**一律走隔离 worktree**(`add --detach` + 软链 `node_modules`,`remove --force` 收尾;**绝不 stash / checkout 对方文件**)。
  macOS `/tmp` 是 `/private/tmp` 软链;沙箱内 `worktree add` 会被回滚 → worktree + 部署一律 `dangerouslyDisableSandbox`、后台跑、日志重定向到 `/tmp/`。
  快照可能「不完整」(依赖只在别人工作区改过)→ **构建后 `grep` 产物确认新 token/类名命中**;线上核对用
  `curl -sL "https://biff-scheduler.pages.dev/<f>.json?cb=$(date +%s)"`(**必须带 cache-buster**,否则边缘缓存会返回旧版)。

## 二、弹层交互(`src/modal.ts`)

- **弹层容器 = 栈**(2026-09-10 起):`openModal(title, body, wide?, onReturn?)` 是**压栈**语义 —— 开新层前把栈顶
  `overlay.style.display = "none"`(**留在 DOM**,不销毁),关闭时恢复下层并调 `onReturn?.()`。
  所以**「详情 ⓘ」这类"从列表进详情"的入口不要再 `closeModal()` 再开**,直接开;用户用头部「← 返回」(栈深 > 1 才渲染)回去,
  列表的搜索词 / 筛选 / 展开态 / 滚动位置全保留。`closeModal()` = 关栈顶;**「定位 ▸」等要跳到页面主体的出口必须 `closeAllModals()`**
  (否则列表还盖着网格);Esc 是**模块级单监听**只关栈顶(原来每层各挂一个 → 叠层时一按全关)。
  被压住的列表要在返回时刷新计数 → 开它时传 `onReturn`(影片库 / 我的选片 / 智能排片三处都传 `render`)。
  列表类 `render()` 拆 `paint()` + 外层保存/恢复 `list.scrollTop`,否则点档位会跳回顶部。
- **弹层里的状态改动必须自己重绘**:`renderAll()` 只重建 chips / 网格 / 行程 / 角标,**弹层挂在 `#modal-root` 下不在任何重建范围内**
  → 弹层内控件「只改数据、按钮文案/配色一动不动」= 像点了没反应。凡在弹层里改状态,点击后要自己就地重绘
  (文案/类名/`title` 三态收口一处,初渲与重绘共用,再配该行 `flash` 作点击回执)。
  **弹层内查状态一律走 `slotOf()`** —— `rebuildIndex()` 是 `store.slotIndex = idx`(整体换新 Map),
  持有开弹层那一刻的引用会读到旧快照,连重绘都会画错(故 `FilmModalCtx.slots` 已删)。
- **按钮「已加入」态 = `@utility act-on`**(浅绿底 + 绿边 + 绿字,与网格 `in-plan` 同一套绿)+ **hover 转红**
  = 「点了就是移除」的意图预告(旧写法 `hover:opacity-90` 在白底描边按钮上几乎看不出)。
  三态按钮统一 `transition` + `active:translate-y-px`。**按钮文案必须与 `toggleScreening` 真实语义一致**:
  一场只属一个方案,对「已在另一组」的场次是**移出**不是搬运 → 文案写「已在 A 组 · 点击移出」(旧「改入 A」是错许诺)。
- **交互类改动的验收方式**:无头 DOM 断言(playwright-core + 缓存 chromium + 临时 `python -m http.server` 对 `dist/`,用完 `pkill`)
  —— 见 SKILL `web-ui-headless-interaction-qa`;对线上只跑**只读**断言,别点会写接口的按钮。

## 三、数据契约

- **单一数据源 `store.picks`**:`Map<filmNodeKey, PickEntry{priority, picks: PickSlot[], note}>`,一部片一条。
  「我的选片」(按片)与「我的行程」(按场次)是同一份数据的两个视图;档位在**影片级**(行程行三段 seg 改的就是该片档位,
  同片多场同步,行内提示「本片共 N 场」),`group` 在**场次级**。旧 `wish` + `store.plan`(`user_plan` 表)已废
  —— 不要再写「两层档位互不影响」。派生 `store.slotIndex: Map<code,{key,group}>`;写入经 `state.ts` 私有 `commit()`
  (本地 → rebuildIndex → notify → 云端 `user_pick` 表);查询走 `slotOf`/`inGroup`/`codesOfGroup`/`priorityOfCode`/`priorityOfKey`。
- **移除场次语义**:行程行 ✕(`removeScreening`)= 只删该场,记录保留(仍在「我的选片」,标「未排场」);
  仅当「档位未设 + 无备注 + 最后一场」才整条删。「整片移除」= `removePick(key)`;设置里「清空」= `clearScreeningSlots()`。
- **影片节点 key 单一来源**:`util.ts` 的 `filmNodeKey(cat, s)`(目录命中 → `cat:<id>`,否则 `sched:<片名小写>`;
  纯目录片 `cat:<f###>`)。影片库合并/智能排片/选片总览/甘特打标全走它。匹配顺序:
  ① `(title_zh || title_orig) === s.title_zh` → `cat:<id>`;② `title_orig === s.title_en` → `cat:<id>`;③ 否则 `sched:<…>`。
- **选片打标共享层 `src/pick.ts`**:收口三档语义(`WISH_ORDER`/`PRI_LABEL`)、色类(`PRI_BG_ON`/`PRI_DOT_BG`/`PRI_TEXT`)、
  分段控件 `buildWishSeg()`;打标走 `state.setWish()`。**Tailwind v4 只生成源码里完整字面量出现的类,勿拼 `bg-${p}`**。
- **档位色 = 冷色专用 token**:`--pri-must #1d4ed8` / `--pri-maybe #7e22ce` / `--pri-wild #64748b`(`@theme` → `--color-pri-*`)。
  旧别名 `--must/--maybe/--wild`、`--status-wild`/`--status-warning` 已删。原因:档位色点画在红绿灯底色卡上,复用状态色会撞色
  (红=冲突/黄=时间紧张/绿=已选)。红绿灯色(`--status-*`/`--conf`/`--color-tight`/`--color-ok`)只服务「排得怎么样」;
  「偏紧」小字用 `text-tight`;「已选 N」计数章用 `bg-biff`。
- **`subs` = `SubsKey[]`(多值)**:册子 META 会同时印多个(实测 `KE KK` 4 场,语义叠加)。契约 `Screening.subs?: SubsKey[]`,
  未标注 = `null`(**不用空数组**)。**渲染必须走 `legend.ts` 的 `subsKeys()` 归一化** —— 数据源可能仍是标量 `subs`,
  不归一化会 `SUBS_DEFS[array]` → undefined → 字幕章全丢。判空用 `s.subs?.length`。解析器侧逐个 `append` 去重,「未认领 token」非空即 WARN。
- **GV 映后谈时长 = 可配置(2026-09-10 改)**:时长 = 单场覆写 `store.gvTalkMinOv[code]` ?? 全局默认
  `Settings.gvTalkMin`(默认 **25**);**不再从 `end_time` 推导** —— 旧口径 `end_time − start − duration`
  (2025 版 347 场 GV 中 345 场 = 25min)只作默认值 25 的来源。仅 `is_gv` 场次生效,0 = 不拆谈段。
  解析收口 **`gv.ts::gvTalkMin`(多久)+ `gv.ts::talkOnOf`(去不去)** —— 后者是原 main.ts 私有 `gvTalkOf` 的下沉,
  网格 / 行程 / 智能排片引擎 / `.ics` 全部走这两处,别再各写一份 `resolveTalk(gvTalk.get(…))`。
  **有效结束口径**:有谈段 → `filmEndMin(s) + (参加 ? 时长 : 0)`(不再取官方 `end_time`,否则改配置不改结束时间,
  配置就是假的);无谈段(非 GV / 时长 0)→ **仍取官方 `end_time`**(保护性分支:2025 有 6 场非 GV 片长 ≠ 槽位
  −2/+1/+15/+90min,一律改走 `start + duration` 会静默改变这 6 场的冲突判定)。配套:`grid.ts::axisRangeFor`
  轴末取 `max(end_time, filmEnd + 时长)`(配置调大后谈块会画到官方槽位外,不外扩就被裁);`markTightPairs` 的
  「已弃映后」判定改为 `gvTalkMin > 0 && !talkOn`(不能拿有效结束与 `end_time` 裸比 —— 配置 ≠ 官方槽位余量时会误判);
  入口:设置弹层「GV 映后谈默认时长(分钟)」+ 行程行 `⏱ N′` 胶囊(小弹层,留空 = 跟随默认;
  **`is_gv` 恒显示** —— 否则全局设 0 后该场再也回不到「有谈段」)。持久化 `biff.gvtalkmin.v1`(与 `biff.gvtalk.v1` 正交)。
- **场次徽章 = `badges.ts` 白名单 + 按族分配 token**:`screeningBadgeKeys()` 对未注册键**静默忽略**
  (2025 的 `talk`/`commentary`/`event` 共 10 场曾被吞)。已注册:`gv`/`masterclass`/`premiere`/`open_talk`/`batch`/`talk`/`commentary`/`event`。
  配色分族:档位 `--pri-*`、红绿灯 `--status-*`、观影等级 `--rate-*`、特别节目 `--ev-teal`(#0f766e,实心 → 实线描边 → 虚线描边表权重)。
  新增徽章同步补 `ABBR_LINES`(图例「ⓘ 缩写说明」数据源)。`opening`/`closing` 故意不注册。
- **★ AI 排片 = 浏览器直连,本站永不经手 Key**(2026-09-10 定案,`src/ai.ts` 文件头有完整契约):
  **「智能排片」= AI 单通道**(原「本地引擎」分段已于 2026-09-10 整体下线,见 PLAN-20260910143516)——
  弹层打开即是 AI 面板;`engine.ts` 现在只剩**排片质量分**(`scorePlanRows`,服务「我的行程」头部药丸)。
  AI 模式三件套 `baseUrl / model / key` + 用户偏好全部只落 **独立 LS 键 `biff.ai.v1`**
  (不并入 `biff.settings.v1` —— 「清除 Key」语义干净,也不会被设置序列化顺手带走);
  请求 = `fetch(用户填的 baseURL + "/chat/completions")`,Key **只放 Authorization header**,
  不写 URL query / body / console / DOM;UI 只显掩码(`ai.ts::maskKey`)。
  **`functions/` 里禁止新增任何 LLM 代理 endpoint** —— 一旦有代理,「Key 不上服务器」即为假;
  `api.ts` 一行不改。主 Prompt 是 `ai.ts::SYSTEM_PROMPT` 常量(硬约束编号 **C1–C6**),**不进 UI、不可编辑**;
  用户偏好作**独立 user 消息** + 守卫句注入。
  **C6 = 用户偏好里的「排除 / 时间限定」类要求**(几点才开始看 / 几点前结束 / 上午不看 / 不要午夜场 /
  只看某几家影院 / 只看某几天)与 C1–C5 **同等硬性**:落在排除范围内的场次**一律进 dropped、不得进 picks**,
  哪怕该片当天仅此一场、或它是 must(2026-09-10 加,修「写了 17:00 开始看却被排 15:30」)。
  本地复检(`parseAiResult`)只管 C1–C3 + 时段重叠,**看不懂自由文本偏好** —— 故 C6 是这类偏好
  **唯一**的约束落点,改 Prompt 时别把 C6 的措辞弱化回「尽量满足」。
  **C6 中文时间表达归一**(2026-09-10 加,见 PLAN-20260910145749):用户写「下午五点开始看」
  时,prompt 强制模型先归一到 24h 数字(下午 = 12~17,「下午五点」= **17:00**,不是 05:00),
  再按 C1–C6 判定;「看到最后一场」= 排到当日最晚(含跨午夜 end > 24:00 的场次),
  不因「看完太晚」或「跨午夜」就保守缩范围。`SYSTEM_PROMPT` 的 C6 段后追加「中文偏好写法对照」
  短段,列举高频口语表达与其正确语义;无片单模式 user 段把「范围够宽时排满」补强为「**应当贪心
  排满 —— 不要只挑 1 场就停**」(旧措辞让模型倾向保守,与「看到最后一场」语义相反)。
  打包只送**已定档**影片(与 `openEngineDialog` 过滤口径一致),且**只送面板所选日期**的场次 ——
  `buildPayload` 的 `dates` 既过滤场次又作 `env.dates`,所选日期内无场次的影片**整条不送**(面板有日期范围
  选择,默认**记住上次选择**—— 2026-09-10 改,`PLAN-20260910162000`:选择落 `biff.ai.dates.v1`,
  首次无存档时仍为**全不选**,此时「开始 AI 排片」按钮禁用 + 状态红字「至少要选一天」;
  收窄日期 = 直接减少上下文与费用);`end` 走 `fmtEndClock`(跨午夜印「次日 05:35」,
  绝不把 24+ 制的 `29:35` 丢给模型);超 12 万字符按 `wild → maybe` 截断,**must 不丢**。
  **返回必须本地复检**(`parseAiResult`):code 白名单 → 同片去重 → 复用 `conflict.ts::computeConflicts`
  (+`gv.ts::effEndMin`/`talkOnOf`)跑冲突剔除 —— **不信任模型自我约束**,否则方案一进网格就红一片。
  **返回是「1~3 个候选方案」**(2026-09-10 加,`PLAN-20260910162000`):模型输出
  `{"plans":[{title,picks,dropped,note}],"note"}`,按用户优先级从高到低排列(方案一 = 最贴合);
  `parseAiResult` 逐方案各自复检、按「场次 code 签名」去掉雷同方案、最多留 3 个,并兼容旧的
  单方案 `{"picks":…}` 格式。UI(`library.ts::optionCard`)每个方案一张可折叠卡 + 独立「并入 A/B」,
  由用户自己挑一个采用(采纳态 / 回执按方案下标各存一份,互不影响)。
  **采纳 = 追加合并,不是整组替换**(2026-09-10 改):出口 = `ai.ts::planMerge()`(按网格同口径剔掉
  「该片在目标方案已有场次 / code 已存在 / 时段冲突」的,返回 `{ add, skipped }`)+ `state.addGroupPicks(g, add)`
  (只追加、不清空、幂等)—— 故「先排 9/19、再排 9/20」可累积进同一方案;旧 `state.replaceGroup()`
  (先清空该方案再落新场次)已删,别再引入。目标方案实时数据取 `codesOfGroup(g)`,不用 `ctx.slots`(开弹层那刻的快照)。
  **无片单模式**(2026-09-10 加,`openEngineDialog` 的 `noFilmList`):**一部片都没打标也能排** ——
  候选池退化为「**全部有排期**的影片」(无场次的目录片不送),档位统一 `wild`(只是「可自由挑选」的
  传输标记,**不代表用户想看**),怎么排由「③ 我的排片偏好」文字决定(如「下午三点看到晚上七点」)。
  该模式下 `callLLM` 必须收到 `{ noFilmList: true }` → user 消息追加【本次模式:无片单】段
  (否则 C4 的措辞会让模型因「没有 must/maybe」交白卷);**并入时档位写 `null`(未设)**,
  不替用户编一个「随缘」(`addGroupPicks` 的 `priority` 因此可空,且 null 不抹已有档位)。
  **面板必须引导「先选片」**(2026-09-10 加,`PLAN-20260910163000`):`modeBar` 在 `tagged` 为 0 时
  除说明「没打标也能排」外,还要给出**直达打标入口**(「去影片库打标 ▸」;从影片库进来时是
  「← 返回影片库打标」,只 `closeModal()` 不叠新层)并写明「候选池会从 N 部缩到你打标的那几部」
  —— 270+ 部 / 700 场一次性送给 LLM 又慢又贵,引导选片既是 UX 也是省钱。落点判定靠
  `openEngineDialog(..., fromLibrary)` 这个参数(影片库 / 我的选片两个入口分别传 `true` / 省略)。
  实测全选 10 天 / 277 部 / 699 场 = 114,089 字符,仍在 12 万上限内(余量约 6k → 片单再涨就要靠日期收窄)。
- **`venue_id` = 按「厅」**(2026-09-10 定案):29 个,`id` = 官方代码小写(`b1`/`c2`/`l10`),`group` = 影院
  (`bcc`/`cgv`/`lotte`/`kofic`/`megabox`/`sohyang`/`bcm`),`region` = 区(`centum`/`nampo`)。**旧「按楼 5 馆」口径已废**
  (`bcc-1`/`bcc-2`/`cgv-centum`/`lotte-centum`/`mega-haeundae`)。`types.ts` 的 `Venue` 有 `region?: string`;
  图例分区走 `legend.ts::GROUP_AREA`。`src/`/`index.html`/`functions/` **零硬编码 venue id**,换口径只需换 `public/*.json`。
- **`Venue.short` = 甘特影厅列的行标签**(2026-09-10 加):影厅列宽 `LABEL_W` 148px,减去内边距 20px +
  代码 chip ≈25~30px + gap 5px → 可写 ≈ 98~103px(12px semibold),而全名「Busan Cinema Center Cinema 1」
  约 178px **必被 `truncate` 裁掉**,且区分性字词全在末尾 → B1/B2/B3 三行都显示成「Busan Cinema …」。
  故 `short` 取「**品牌 + 厅号**」并去掉与品牌重复的城市词:`BCC Cinema 1` / `BCC Cinematek` /
  `CGV 1` / `CGV IMAX` / `LOTTE 10` / `MEGABOX 1` / `KOFIC Theater` / `Busan Media Ctr`。
  **实测(Chromium + 本机字体栈,12px semibold)29 条全部 ≤ 98px、零截断** —— 改 `short` 必须重量一次,
  超过 98px 就会重新截断(而 MEGABOX 四行截断后又会糊成同一串,即本次修的 bug)。
  **取用只走 `legend.ts::venueShort()`**(`short || name`,旧 JSON 不会空白);`venue_display` 与 `name` 保持全名 ——
  全名去向 = 行 hover `venueTip` / ⓘ 说明弹层「代码 → 行标签 → 官方全名」表 / ICS `LOCATION`。
  数据源 = `tools/extract_schedule.py::VENUE_NAME` 第 5 元素(重跑 PDF 管线不会丢),同步 `public/venues.json`。
- **★ 午夜场跨天 = 24+ 时制**(2026-09-10 定案):`end_time` 可 ≥ `"24:00"`(`"29:35"` = 次日 05:35)。
  **任何地方都不得对小时取模**。唯一归一化闸门 = `data.ts::loadCatalog()`(`end <= start` → `minToHms(en + 1440)`)。
  显示一律走 `util.ts` 的 `minToClock`/`fmtEndClock`/`fmtMinRange`/`nextDayTag`(`minToHms` 只供数据层与 ICS,勿直接显示);
  ICS 的 `DTEND` 靠 `Date.UTC` 自动进位。实测 4 场:`008`/`081`/`164`/`244`(23:59 → 次日 05:26~06:04)。
- **目录片(暂无排期)豆瓣关联**:`f###`(f001…)与排期 3 位 code 互不冲突,同存 `douban_map` 表;影片库节点 key `cat:f###`。
- **`FilmItem` 契约**(`src/types.ts`):`{ id, unit, remark, title_zh, title_orig, year, rating, rating_count, country, director }`
  —— 10 字段,**无** `runtime_min`/`title_kr`/`codes`。`displayTitle` = `title_zh || mappingTitleCn || title_en`。
  `library.ts::unitKey()` 对未知 unit **回退原字符串**,故英文单元名安全。

## 四、渲染 / 样式

- **甘特画布底板 `--bg-page`(#f4f4f5)**:`grid.ts` 的 `scroll` 容器 + 粘性场馆列 `LABEL_BOX_CLS` 都挂 `bg-page`
  (旧 `bg-card` 白卡叠白面板,像孤立文字);未选中卡片走 `isIdle` 档(`CODE` → `text-muted`、时间/片名 → `text-ink-2`、
  `hover:border-line-strong`),已选(绿)/另一方案(虚框)/冲突(红)仍黑字。
  **换画布底色时必须自查依赖 `hover:bg-hover`(#fafafa) 的 hover 底**(灰底上 hover 更浅 = 无反馈;标尺整点按钮已改 `hover:bg-card` 白药丸)。
- **Tailwind v4 `@utility` 权重陷阱**:`@utility` 只生成单类选择器(`.hl-card` = (0,1,0)),而 `hover:` 变体 = (0,2,0)。
  「JS 运行时打上的状态类」要覆盖元素自身 `hover:` 工具类,声明必须带 `!important`(本仓库 `hl-card`/`hl-row` 的
  `border-color`/`box-shadow`/`z-index` 已统一如此)。踩坑:正片卡自带 `hover:shadow-[var(--shadow-hover)] hover:z-[2]`
  → 吃掉 `hl-card` 外晕,表现为联动「单向亮」。排查:先确认 JS 侧打的类对称,再查 CSS 权重。
- **甘特缩放(2026-09-10)**:
  - 刻度 = `PX_PER_MIN × store.settings.zoom`(默认 1 = 100%);倍率离散阶梯
    `[0.35, 0.5, 0.7, 1, 1.4, 2, 3]`,沿阶梯走用 `grid.ts::stepZoom`。
  - `PX_PER_MIN` 是 grid 内部基准刻度;`main.ts` 的缩放锚点换算依赖
    `轴起点 = axisStartFor(cat, date)` 与 `轨道内 x = labelMetrics(pxPerMin).labelW`,由 grid.ts 单一来源导出。
  - **影厅列宽随缩放一起变(2026-09-10 改)**:`grid.ts::labelMetrics(pxPerMin)` 单源导出
    `{labelW, chipW, fontPx, padX}` —— 100% 列宽 ≈49px(只装一枚代码 chip),300% ≈87px、chip 字号 10 → 18px。
    旧版 `LABEL_W = 148` 恒定,只有轨道在伸缩,用户否定这不是「缩放」。字号按 `z^0.6` 阻尼
    (线性则 300% 要 30px 字号 + 150px 列宽,视觉上只剩空白);`chipW = round(fontPx·2.8)`、`padX = fontPx`,
    三者同源挂在字号上 ⇒ 列宽与 chip 严格等比。
    ⚠ 列宽**不能**拼 Tailwind 字面量类(`grid-cols-[${n}px]` 生成不出来,`@utility` 那套权重陷阱同源)
    → 一律内联 `gridTemplateColumns`(`ROW_BASE_CLS` 已退化成只有 `"grid"`,`LABEL_BOX_CLS` 去掉 `px-[10px]`)。
    `main.ts` 三处锚点换算(`gridAnchor` / `applyZoom fromLeft` / `renderGrid` 回写 `scrollLeft`)
    **必须全部走 labelMetrics**,各自独立算就会在缩放瞬间跳位;`fitZoom` 因列宽依赖倍率需**两次迭代**收敛
    (单次算 z>1 会溢出)。
  - **行标签 = 官方影院代码 chip(2026-09-10 改)**:只放 `B1` / `BT` / `L10` / `BCM`,整格 hover 出
    全名 + 韩名 + 分区(`legend.ts::venueTip`)。旧版放影院名:148px 列只有 ~100px 可用而全名要 205px
    → 必被 `truncate` 裁成「Busan Cinema …」,且 B1/B2/B3 三行一模一样。改代码后列宽可缩到 49px,
    时间轴多出约 100px。
  - **「1:1」按钮回原始比例 100%(2026-09-10 加)**:缩放控件 = `− / 百分比(纯读数,非按钮) / + / 适应 / 1:1`;
    旧版把中间百分比做成按钮,用户反馈「没发现」。`renderZoomCtl` 每次 `replaceChildren` 换节点。
  - 网格每次重建都换新滚动容器,**缩放锚点按「旧刻度算 + 新刻度回写」换算**(`pendingAnchor`),
    不能沿用旧 `scrollLeft` —— 同一日期内换刻度会跳。切日期 / 首渲 anchor=null → 回最左。
  - 缩放写 `store.settings.zoom` 走 `state.ts::setZoom`(只落盘、**不 notify**)——
    缩放只影响网格,让 renderAll 重建行程/角标是白干;且必须先算锚点再改倍率。

- **对齐语言(2026-09-10 定案,`PLAN-20260910151027`)**:统一为「**信息 / 状态靠左,操作按钮靠右**」——
  面板头(`justify-between`)、列表行操作(`justify-end`)、弹层头(`← 返回` + `✕`)、弹层底部主按钮
  (`justify-end`,次要操作在主按钮左侧)、AI 面板 `readyBar` / `resultCard` 头 / `dateBar` 与
  `promptArea` 底部、豆瓣表单「保存映射」全部同一口径。
  **折行容器(`flex-wrap`)里的操作组用 `ml-auto` 而不是 `flex-1` 占位符** —— 折行后仍贴右缘。
  **唯一例外** = AI 面板 `runBar`:主按钮文案自带步骤号「④ 开始 AI 排片」,保持左对齐以贴合 ①②③④ 步骤流。
  弹层内主按钮落位见 §二「底部主操作右对齐」。

## 五、基础设施 / 工具

- **D1 / SQLite 改列约束只能重建表**:SQLite 不支持 `ALTER TABLE … ALTER COLUMN … DROP NOT NULL`。
  走「`CREATE TABLE x_new` → `INSERT INTO x_new SELECT` → `DROP TABLE x` → `RENAME TO x` → 重建索引」,先 `DROP TABLE IF EXISTS x_new` 兜重跑。
  改完**先本地 sqlite 跑 0001 + 全部新迁移**确认旧行保留/索引重建/旁表无影响,再 `npm run migrate:remote`。
- **wrangler 必须在沙箱外跑**:沙箱内到 `api.cloudflare.com` fetch failed。`d1 migrations list/apply`、`pages deploy`、
  `d1 execute --remote` 一律加 `dangerouslyDisableSandbox`。`npx wrangler d1 execute <db> --remote --json --command "…"`
  是核对线上表结构/数据最快手段(输出用 python 解 JSON)。
- **改 D1 契约三件套顺序**:迁移(改库) → 部署(Functions + 前端) → `curl` 打线上 `/api/...` 端到端探针
  (**用不存在的 code 探针,探完 DELETE,别污染真实数据**)。
- **`tools/extract_schedule.py`**(BIFF 适配层):排期表 = 官方册子 **p9–p16**(旋转 90° 的表格)。
  与电影节无关的通用逻辑已抽到 **`tools/festival_common.py`**(以 `LayoutSpec` / `MetaSyntax` 注入差异);
  新增电影节时复制适配层、替换场馆表与 token 正则即可,输出契约对齐 `src/types.ts`。
- **`tools/extract_films_2025.py`**(2026-09-10 新建):影片介绍页 = **p22–p97**(印刷页 42–194),
  每页 2 栏(`x0 < 250` 为左栏),**每遇到一条元数据行 `<国别>|<年>|<N>min|<格式>|<color>` 就开启一部新片**,
  其后到下一元数据行的场次行都归它(**不能用 y 窗口** —— 一页 2~3 部片);国别过长会换行 → 按 **x 邻近(±20pt)** 回看;
  单元按 p18 `SECTIONS` 起始印刷页;片名按 `code` 关联排期(排期表才是权威)。输出严格只含 `FilmItem` 十字段。
  完整工作流 + 19 条陷阱见 **`.codebuddy/skills/biff-catalogue-pdf-to-schedule/SKILL.md`**。
- **排期的 `page` 字段不是影片唯一键**:一个印刷页装 3 部片(89 个 `page` 值带多片名,如 `page=119` → The Blue Trail + The Chronology of Water),
  另有 10 个 code 的 `page` 为空(`800`/`164`/`X1601`/`621–626`/`002`)。**关联方向是反的**:从影片介绍页读出该片的 code 清单,再用 code 去排期取片名。
- **实测基线**:2025 = **699 场 / 29 厅 / 10 天(09-17~09-26)**;影片目录 **224 片**(`cat:` 命中 646/699 = 92.4%,
  未命中的 53 个全是非影片条目)。2026 目录暂存 `data/films-2026.json`(明天片单发布后复用)。
- **2025 排期已知缺陷(未修)**:`public/schedule.json` 里 `008.title_en = "163, 165 Midnight Passion 1"`、
  `164.title_en = "115, 160, 163, 164 Midnight Passion 3"`、`800.title_en = "Winner of the Camellia Award] Special Talk […"`,
  根因是 `extract_schedule.py::split_title()`。
