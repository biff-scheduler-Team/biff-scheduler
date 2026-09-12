# BIFF Scheduler · 釜山电影节排片工具


账号登录、全局资料编辑与排片同步的配置及测试方法见 [账号接入说明](docs/account-integration.md)。

把[釜山国际电影节](https://www.biff.kr/)的官方排期表，变成一张**可点选的甘特网格**：

> **选片 → 冲突检测 → 双方案（A/B）对比 → 导出 `.ics` 进手机日历 → 一键跳豆瓣**

前端以 TypeScript 编写，数据本地优先。访客可离线使用，登录 IFFDAY 后可跨设备同步。前后端通过 npm workspaces 分离，分别部署为 Cloudflare Workers；后端使用 Hono、Drizzle ORM 和 D1。

[![Deploy](https://img.shields.io/badge/online-biff.lcandy.co-ce1e36)](https://biff.lcandy.co)
[![Stack](https://img.shields.io/badge/stack-Vite%206%20·%20TypeScript%205%20·%20Tailwind%20v4-3178c6)](https://vitejs.dev/)
[![Host](https://img.shields.io/badge/host-Cloudflare%20Workers-f38020)](https://workers.cloudflare.com/)
[![Tests](https://img.shields.io/badge/tests-vitest-passing-3fb950)](./tests)

> **当前状态**：核心链路（排片网格 / 冲突检测 / 行程 / 选片 / 影片库 / `.ics` 导出 / 豆瓣跳转）均已实现并部署冒烟通过。
> 仓库内置的是**第 31 届（2026）真实数据**：**750 场 / 26 厅 / 10 天（10/6–10/15）/ 250 部影片**，
> 排期 / 片名 / 分级 / 字幕 / GV 全部由 `tools/scrape_biff_web.py` 从 biff.kr 官网实时页面抓取，
> 影片目录来自官方影片信息 xlsx（`tools/build_films.py`）。2025 第 30 届的 699 场数据仍保留在 git 历史里。

---

## 目录

- [一、这是什么](#一这是什么)
- [二、快速开始](#二快速开始)
- [三、使用指南](#三使用指南详细)
- [四、技术栈](#四技术栈)
- [五、架构与数据流](#五架构与数据流)
- [六、目录结构](#六目录结构)
- [七、开发与部署](#七开发与部署)
- [八、项目能力（Skills）](#八项目能力skills)
- [九、数据从哪来](#九数据从哪来部署时不需要解析-pdf)
- [十、数据说明与许可](#十数据说明与许可)

---

## 一、这是什么

一个「一个人的电影节排片工作台」。电影节的官方排期是一张巨大的 PDF 表格（影院 × 时间），人工看片、排时间、算转场、防撞场非常痛苦。这个工具把它变成：

- 一张**横向时间轴 × 纵向影厅**的甘特网格，点一下就加入行程；
- 自动检测**时间重叠**与跨馆转场余量；
- **顺位 = 偏好次序，方案 = 所有无冲突组合**：同一时间带重叠的几场在「我的行程」里折叠成一张**绿框顺位卡**
  （绿框 = 已处理好，不是警报），**拖动排序**即排出「先保哪一场」；工具把「每个冲突组各取一场」的
  **全部组合**逐套校验后列成方案对比（2 组各 2 场 → 4 套），按顺位成本排序；
- 一键导出标准 `.ics`，直接进 iOS/Android 日历（含提醒），或生成一段可粘贴到微信的**分享文案**。

**设计取舍**：单用户自用工具，追求零成本与零重依赖。网格对交互定制要求极高（冲突联动、跨午夜 24+ 时制、缩放锚点、就地 patch 复用），现成组件库要么付费、要么样式难融、要么体积过大 —— 自研反而更小更可控。

---

## 二、快速开始

### 在线使用（已部署）

打开 **https://biff.lcandy.co** 即可。无需注册、无鉴权；站点已在 `robots.txt` / `<meta name="robots">` 里禁止收录，仅个人自用。

### 本地运行

```bash
npm install

npm run dev          # 本地开发服务器（Vite）
npm run typecheck    # tsc --noEmit
npm run test         # vitest run（纯函数口径单测）
npm run build        # typecheck + lint + test + vite build
npm run preview      # 构建后用 wrangler dev 起本地 Worker 静态资源环境（前后端 Worker）
```

> **账号与数据**：访客数据保留在浏览器；登录 IFFDAY 后，可选择导入并同步至独立 D1。前端位于 `apps/web`，Hono + Drizzle 后端位于 `apps/api`，共享接口类型位于 `packages/contracts`。详见 [账号接入](docs/account-integration.md)。

---

## 三、使用指南（详细）

### 1. 顶栏

| 控件 | 作用 |
|---|---|
| **A 方案 / B 方案** | 切换当前正在编辑的方案。选片、行程、冲突检测、导出都按「当前方案」生效；两套方案互不干扰 |
| **⚠ 冲突角标** | 当前方案存在冲突时出现，点它打开选片抽屉并切到「我的行程」tab |
| **选片 · 行程** | 开 / 收左侧**挤压式抽屉**（内含「影片库 / 我的选片 / 我的行程」三个 tab） |
| **导出 .ics** | 下拉菜单：导出 A 方案 / B 方案 / A+B 全部 / 分享文案（复制） |
| **外观（跟随系统 / 亮 / 暗）** | 三段选择器，点哪段就是哪段；首屏由 `<head>` 内联脚本防闪白 |
| **设置** | 提醒提前量、跨馆转场缓冲、GV 映后谈默认、清空场次 |

### 2. 排片网格（甘特）

- **日期快捷条**：顶部一条浅灰胶囊轨道（官方「Schedule by Date」同款），选中项是浮起的白底红字胶囊；点选切换当天，标题右侧显示当日场次数。
- **筛选（字幕 / 影厅 / GV）**：日期条下方三行筛选轨道 ——
  - **字幕**：`KE / KN / KK / NO / 未标注`（多选；未标注 = 官方缺省「英文字幕 + 韩语对白」）；
  - **影厅**：26 个厅逐厅多选（标签走 `short` 短名，如 `BCC Cinema 1` / `CGV 3` / `LOTTE 10`）；
  - **场次**：`仅 GV` / `非 GV` 三态单选。
  三道之间是**与**关系，各自内部是**或**。不匹配的场次只**淡出**（不隐藏、不改几何 → 网格不跳版），
  标题右侧实时显示 `命中/总数 场（已筛选）`；任一筛选生效时出现「清除筛选」。
  ⚠ 筛选不随切日期清空（筛的是「看什么」，跨日有效）。
- **点选加入 / 移出**：点击任意场次卡片即加入行程（整卡淡绿底）；再点一次移出。
- **状态配色**（三套互相独立）：
  - **红**：两场放映时间重叠 → 整卡红底红框 + 右上角红点（跨行时用红虚线把重叠时段连起来）；
  - **黄**：已选场次里相邻两场衔接偏紧（间隔小于转场缓冲，或余量不足 15 分钟）→ 整卡淡黄底；hover 卡片可看到完整算式；
  - **绿**：已加入行程。
- **跨馆转场余量（gap-bar）**：相邻两场之间若需跨影院，会显示余量条，三态 `ok / tight / bad`。
- **双向 hover 联动**：鼠标移到网格卡片上，同一冲突组与「我的行程」里对应的行会一起高亮；反向亦然。
- **缩放**：`− / +` 沿离散阶梯缩放（影厅列宽、时间刻度、卡片字号同倍率伸缩），「适应」把当天整条时间轴塞进视口，「1:1」回到基准比例。缩放是纯视图偏好，会自动记忆。
- **行标签**：左侧粘性列显示官方影院代码 chip（`B1` / `BT` / `L10`…），整格 hover 出全名 / 韩名 / 分区。
- **场次徽章**：观影等级（ALL/12/15/19）、字幕/对白标识（KE/KN/KK/NO）、节目册页码、片长、GV / Masterclass / Premiere 等，均以小徽章渲染，每枚 hover 即说明。
- **ⓘ 日程表说明**：顶栏入口打开**分区卡片式说明弹层**（880px 宽，8 个分区）—— 「一格怎么读」（画成一张模拟网格卡）· 观影等级 · 字幕/对白标识 · 场次特性徽章 · 影院与官方代码 · 网格与行程图例 · 我的选片 · 特别提示；每个字段 / 徽章都可在弹层里 hover 看即时解释。
- **渲染策略**：网格按「几何签名不变 → 就地 patch 状态」，点选 / 冲突变化 / 时间筛选都不会重建 DOM（滚动位置与自定义属性天然保持）。

### 3. 我的行程

- 按日期分组的议程列表，显示已排的全部场次。
- **冲突组顺位卡**：同一时间带互相重叠的几场折叠成一张**绿框卡**（绿框 = 这组已处理好，不是警报），
  卡片头第 1 列的 **⠿ 把手可上下拖动** —— 组内顺序就是**偏好次序**（顺位 1 = 最想要）。
  **顺位不决定分组**，它只回答「先保哪一场」。红色只留给真异常（有的组合内部仍撞车）。
- **方案对比**：行程顶部把「每个冲突组各取一场」的**全部组合**并列列出 —— 每一套都经冲突校验、
  保证内部不重叠；按**顺位成本**（各组所选顺位之和）排序，都取首选的那套排最前。
  每张卡只列差异场次（共同场次各套相同，折成一行计数），一屏看清每套保哪几场。
- **✕** 只移除该场（选片保留，该片仍留在「我的选片」里，标为「未排场」）。
- **映后胶囊**：GV 场次可单独覆写映后谈时长 / 是否参加（留空 = 跟随全局默认）。
- 头部显示场次数、冲突数，以及一个**排片质量分**药丸（`场次数 + GV − 紧转场`）。
- 日期头可点击 → 网格切到该日期、横向居中到当天最早一场、当天场次批量闪烁高亮。

### 4. 我的选片

- 「按片看」的总览视图：一部片一条记录，显示已排场次、备注。
- 可按日期筛选、点「定位 ▸」跳到网格并闪烁高亮、或整片移除。
- 与「我的行程」是**同一份数据的两个视图**，永远一致。

### 5. 影片库

- 浏览全部影片目录（2026 基线 **250 部**），支持搜索：中文名 / 原始片名 / 场次 code / 单元 / 导演。
- **海报缩略图**：174/250 部有（豆瓣 subject_id 对齐 `apps/web/public/posters/` 的本地图，`tools/fetch_posters.py` 下载）；缺图的卡片**不留空列**，片名左缘不参差。
- **排片筛选**：与时间轴**共用同一份状态**（字幕 / 影厅 / GV）—— 在影片库里勾完，切回甘特图仍是同一套口径。抽屉只有 520px 宽，这里走**可折叠**形态（「▸ 筛选」+ 生效摘要 + 清除）；筛的是「这部片还有没有我要看的场」，没有就直接不列，展开的场次列表同样过筛。
- **单元筛选 chips**：按单元（主竞赛 / Icons / 亚洲电影之窗…）快速收窄。
- **行内展开场次**：每部片展开后列出它的所有场次（只读，配「定位 ▸」）。
- **「＋ 加入我的选片」**：把影片收进选片清单（场次在「我的选片」里挑）。
- **定位 ▸**：跳到网格对应日期并滚动闪烁到该场。
- **资料 ⓘ**：打开影片资料弹层（元信息 + 豆瓣条目直链 / 搜索跳转）。

> **抽屉而非弹窗 / 独立页**：选片抽屉打开后网格**完全可见可点** —— 点选 → 卡片当场变绿。根因是「选片」与「选场次」本是同一件事的两步，不应被换页或遮罩打断。

### 6. 导出与分享

- **`.ics` 导出**：标准 iCalendar，时间一律 UTC，`UID = <code>@biff-2026`，含相对提醒（默认提前 45 分钟，可在设置改）、场馆。导入手机日历后按手机时区显示。
  ⚠ **导出不分方案** —— 全部已选场次一起导出（冲突双方在日历里同时存在是用户明知的状态，抢票时抢到哪个去哪个）。
- GV 场次的结束时间会按「是否参加映后谈」动态计算，`.ics` 与冲突检测口径一致。
- 严格遵守 RFC 5545：文本转义（`\` `;` `,` 换行）+ 按 **UTF-8 字节**折行（含 `VALARM` 的 `DESCRIPTION`）。
- **分享文案（复制）**：按「日期分节 + 两行一场」生成的纯文本（时间 / 片名 / 影院 · CODE），粘贴到微信也读得清。

### 7. 豆瓣跳转

- 影片资料弹层「豆瓣」区：**有映射** → 豆瓣条目直链；**无映射** → 「中文搜索 / 英文搜索」两个外链（跳 `douban.com/search`）。
- 有映射时还会列出 **本届也在放**（豆瓣推荐里正好也在本届片目的,点开即进那部资料）和 **豆瓣也推荐**（其余外链,最多 6 条）。数据来自离线产物 `apps/web/public/douban-related.json`。
- 影片库「无排期目录片」行内也有一枚「豆瓣搜索 ↗」。
- 映射是**离线产物** `apps/web/public/douban.json`（`tools/build_douban_map.py` 用豆瓣**官方 API** 生成），**页面上不可编辑**；留空即全站走搜索兜底。
- 评分徽章（`豆 x.x`）来自 `apps/web/public/films.json` 的 `rating`（官方影片信息表），与映射无关。
- **不做浏览器直连**：官方接口要签名（`apikey/_ts/_sig`），而浏览器**设不了 `User-Agent`**、跨域也被拦、`app_secret` 会随产物外泄 → 只能离线跑（详见 `docs/plans/PLAN-20260911223200.md`）。
  ⚠ 官方口有两处**按 IP 的风控**：`search/subjects` 跑约 100 次即 `403 need_login`（登录流程未恢复，**别用这个口**）、详情口 `code=1309 subject_ip_rate_limit`；风控期间检索仍返回 200，**极易被误记成「豆瓣没有这部片」**，故脚本命中风控码即停轮保进度。

### 8. 设置

| 设置项 | 说明 |
|---|---|
| 提醒提前量 | `.ics` 闹钟提前分钟数（建议 30–60） |
| 跨场馆转场缓冲 | 判定跨影院场次冲突所需的余量（同影院不受影响；默认 0 = 仅判时间重叠） |
| GV 映后谈默认 | 全局默认是否参加 + 默认时长（分钟）；单场可在行程里覆写 |
| 清空全部已排场次 | 只清场次，**保留**「我的选片」里收着的影片与备注 |
| 清空全部（选片 + 排片） | 把「我的选片」与「我的行程」一起清空（备注 / 场次 / 顺位全删）。**片单只存本机，清完刷新 / 部署都不会再回来** |

### 9. 抢票信息（开票倒计时 / 票价 / 节目嘉宾）

数据来自官网 **Booking Information** 等活动页（离线抓取 → `apps/web/public/festival-extras.json`，见 §九）。

- **顶栏开票倒计时**：未到开票时显示「距第 N 批开票 X 天 Y 小时 · 京 `9/17 13:00` / 韩 `9/17 14:00`」——
  ⚠ **同时给两个时区**：官网印的是韩国时间（KST），人在国内看的是北京时间（= KST − 1h），并排显示不必自己换算。
  全部批次开完后切「售票中」。**无 `festival-extras.json` 时横幅自动隐藏**（纯增强，不阻塞主流程）。
- **点击横幅 → 「抢票信息」弹层**：
  - **开票批次**：第一批（开闭幕式 / Open Cinema / Midnight Passion / **Actors' House** / Community BIFF）、
    第二批（普通场次 / **Master Class** / Cine Class），各带倒计时与「已开票」态；
  - **票价**：开闭幕式 ₩30,000 · Midnight Passion ₩20,000 · Actors' House / Master Class ₩15,000 ·
    普通场次 / Cine Class ₩10,000；折扣 −₩3,000（老人 / 残障 / 退伍军人，需证件核验）；
  - **购票须知**：Chrome、弹窗拦截、每场限 2 张、排队号机制、客服 1666-9177（官网英文原文的关键条目给了中文摘要）；
  - **开闭幕式**：红毯时间表（17:00 入场 → 18:00 红毯 → 19:00 主活动 → 20:20 放映）+ 当天封路时段；
  - **加入日历提醒（.ics）**：把两批开票时刻导出成日历事件（提前 30 分钟提醒），导入手机日历即可。
- **网格卡嘉宾章**：Master Class / Actors' House / Cine Class / Special Talk 的卡片徽章行**最前面**多一枚嘉宾名
  （中文名优先，如「罗泓轸」），hover 给出形式 / 嘉宾 / 票价；**详情弹层（ⓘ）**另有完整「活动节目」区（形式 / 嘉宾 / 语言 / 票价 / 简介）。
- **行程票价**：每场场次行右缘显示票价（如 `₩15,000`），日期头显示「当日 ₩XX,XXX」，抽屉摘要行显示「票 ₩XXX,XXX」（全部按官网价目表估算，以购票页实付为准）。

---

## 四、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 构建 | **Vite 6** | 输出到 `apps/web/dist/`，`base: "./"`；`apps/web/public/*.json` 原样拷贝进产物根目录 |
| 语言 | **TypeScript 5** | 全量类型标注，`tsc --noEmit` 作为构建前置门禁 |
| 前端框架 | **无** | 手写 TS + DOM，网格 / 冲突 / 徽章 / 弹层栈 / 甘特缩放全部自研；未引入任何组件库 |
| 样式 | **Tailwind CSS v4**（`@tailwindcss/postcss`） | **增量双轨**：不引 preflight，存量语义类读设计 token，新 UI 用 utility；token 是唯一色源 |
| 主题 | **三态**（跟随系统 / 亮 / 暗） | CSS 只认 `:root[data-theme]`；「跟随系统」由 `theme.ts` 用 `matchMedia` 就地解析 |
| 测试 | **Vitest** | 纯函数口径单测（24+ 时制 / GV 有效结束 / 冲突 / `.ics` / 网格卡状态），`npm run build` 前置门禁 |
| 代码质量 | **ESLint 10** + `typescript-eslint` | `npm run lint`，同为构建门禁 |
| 部署 | **Cloudflare Workers** | 前端 `biff-scheduler-web`，API `biff-scheduler`，共享公开入口 `biff.lcandy.co` |
| 离线 | **PWA**（`vite-plugin-pwa`） | 预缓存产物 + 五个只读 JSON → 现场断网可用；方形 PNG 图标可加到主屏（含 iOS 180） |
| 运维 | **Wrangler 4** | 本地预览、Workers 部署（**无 D1 / 无 Functions**） |
| 离线管线 | **Python**（stdlib + openpyxl）+ Node 脚本 | 从 **biff.kr 官网排期页**抓 `schedule.json` / `venues.json`，从官方影片信息 **xlsx** 生成 `films.json`；产物检入仓库，**仅在更新数据时需要**，部署链路不依赖它 |

**无障碍与可达性**：弹层 `role=dialog` + focus trap + 焦点归还 + body 滚动锁；toast `aria-live`；tooltip 触屏与键盘可达。

---

## 五、架构与数据流

```
离线数据管线（本机 Python / Node，非部署部分）
  biff.kr 官网排期页（date.asp）+ 官方影片信息 xlsx
    └─ tools/*.py ──► apps/web/public/schedule.json · venues.json · films.json · douban.json
                      （只读、版本化、可 diff）

前端应用（独立 Cloudflare Worker：biff-scheduler-web）
  apps/web/dist/（Vite 构建产物）
  ├─ schedule.json（只读排期）
  ├─ venues.json（只读场馆）
  ├─ films.json（只读目录）
  ├─ douban.json（豆瓣映射，离线产物，可为空）
  ├─ festival-extras.json（售票 / 节目嘉宾 / 开闭幕式，离线产物）
  └─ assets/（main.ts 打包）

浏览器 localStorage（访客与离线工作区；登录后可同步至 D1）
  ├─ biff.picks.v2                          选片 + 排片（唯一数据源）
  ├─ biff.settings.v1                       设置（提醒 / 转场 / GV 默认 / 主题）
  └─ biff.gvtalk.v1 · biff.gvtalkmin.v1     GV 单场覆写
```

**数据分层原则**：

- **官方排期** = 只读静态 JSON（前端按 code 反查权威数据，版本化、可 diff）；
- **片单（选片 / 排片）** = **只存浏览器 localStorage**，不写云端 —— 刷新 / 重新部署都不会「复活」；
- **豆瓣映射** = 只读静态 JSON `apps/web/public/douban.json`（离线产物，留空即走搜索兜底）—— 影片目录随前端部署，用户片单通过账号 API 同步。

**核心数据模型**：全站唯一数据源是「**一部片一条记录**」（`film_key → { picks[], note }`）。

- 记录在**影片级**（一部片一条）；
- 已选场次在**场次级**（同一部片的两场可以分属不同顺位）；
- **抢票顺位**也在场次级（`state.ts::rankOf: Map<code, number>`,独立键 `biff.ranks.v1`），
  它只回答「冲突组里先保哪一场」,顺序即方案编号（`plans.ts::buildPlanSet`）；
- 「我的选片」（按片看）与「我的行程」（按场次看）是这份数据的两个视图，永不打架。

**前端模块（`apps/web/src/`，28 个 `.ts` + `style.css`）**

| 文件 | 职责 |
|---|---|
| `main.ts` | 装配 + 全局事件委托 + 导出 / 缩放 / 双向 hover 联动 |
| `state.ts` | 全局 store、localStorage 持久化（**片单只存本地**）、派生索引（`groupIndex` / `slotIndex`）与订阅分域 |
| `grid.ts` | 甘特排片网格（时间轴、粘性影厅列、缩放锚点、gap-bar、就地 patch） |
| `agenda.ts` | 我的行程列表（冲突组**绿框顺位卡**：拖动排偏好次序 + **方案对比**并列卡片） |
| `library.ts` | 影片库 + 我的选片（左侧挤压抽屉，三 tab） |
| `settings.ts` | 设置弹层 + GV 映后时长小弹层 |
| `theme.ts` | 三态外观（跟随系统 / 亮 / 暗）→ `data-theme` 落盘与系统变化监听 |
| `share.ts` | 分享文案（复制）——「两行一场 + 日期分节」纯文本 |
| `score.ts` | 排片质量分 |
| `conflict.ts` | 纯函数冲突检测（转场余量可注入）+ 冲突组（连通分量） |
| `plans.ts` | 纯函数：冲突组 + 顺位 → **N 套方案**（含「同一套内部不重叠」的校验） |
| `ics.ts` | `.ics` 生成（UTC、跨午夜进位、GV 映后、RFC 5545 转义与折行） |
| `gv.ts` | GV 映后谈时长 / 是否参加的统一解析口径 |
| `row.ts` | 场次行单一构造（影片库 / 我的选片 / 我的行程共用） |
| `badges.ts` / `legend.ts` | 场次徽章注册表 / 图例与场馆说明（`buildGuideBody` = 「日程表说明」分区卡片弹层） |
| `modal.ts` | 弹层栈（开新层压住下层、返回恢复滚动与筛选态）+ 宽度档 `md` / `lg` / `xl` |
| `filters.ts` | 排片筛选（字幕 / 影厅 / GV）的状态与判定（网格与抽屉各持一份） |
| `ui.ts` / `chips.ts` / `form.ts` / `toast.ts` | 按钮·tab·缩放控件类名与工厂 / 胶囊 chip 类名 / 表单行骨架 / Toast 的共享层 |
| `data.ts` / `related.ts` / `tip.ts` / `types.ts` / `util.ts` | 数据加载与归一（含豆瓣映射 `douban.json`）/ 豆瓣相关电影 / 悬停提示 / 类型 / 工具（含 `slackBetween()` 转场余量） |
| `style.css` | 设计 token 唯一色源（`:root` 字面值 → `@theme` 映射）+ 原生语义类 |

**样式与适配**：设计 token 是唯一色源；字阶 / 圆角走**值命名**阶梯（`text-12` = 12px、`rounded-8` = 8px，全站已无 `text-[Npx]` 任意值）；暗色**只覆盖 token**（零 utility 改动）；窄屏（≤768px）走**列表优先**（默认打开选片抽屉，网格降级为次级入口）。

**API**：**本站没有 API**。片单只落浏览器 `localStorage`，豆瓣映射是静态文件。`/api/pick*`、`/api/mapping*` 与 D1 `douban_map`、`functions/` 目录均已退役删除。

---

## 六、目录结构

```
├─ apps/
│  ├─ web/                 # Vite 前端：src、public、tests、dist
│  └─ api/                 # Hono API：src/db、migrations、Drizzle 与 Wrangler 配置
├─ packages/contracts/     # 前后端共享接口与数据序列化
├─ e2e/                    # 跨账号、跨设备与同步 E2E
├─ tests/                  # 数据库兼容性检查
├─ tools/                  # 离线数据管线
├─ scripts/                # 本地联调与自动部署
├─ skills/                 # 项目能力与流程
├─ data/                   # 离线中间产物
├─ docs/                   # 工程约定、账号接入与历史记录
└─ PLAN.md                 # 项目记录
```

---

## 七、开发与部署

```bash
npm install

npm run dev                 # 本地开发（Vite，无 Functions）
npm run typecheck           # tsc --noEmit
npm run lint                # eslint src tests
npm run test                # vitest run（纯函数口径单测）
npm run build               # typecheck + lint + test + vite build
npm run preview             # 构建 + wrangler dev（前后端 Worker）

# 部署 = git push（唯一常规路径）
git push origin main        # → Cloudflare Workers Builds 自动构建上线 https://biff.lcandy.co

# 兜底：本机直传（需本机 wrangler 已登录部署账号 62cbe67b…，配置见 apps/web/wrangler.jsonc assets）
npm run deploy              # 构建 + wrangler deploy
```

> **部署口径（2026-09-11 修正）**：线上 = **Cloudflare Workers** 项目 `biff-scheduler`（账号 `62cbe67b545f2d12c986729ac7ffcee8`），
> 自定义域 **https://biff.lcandy.co**，由 **GitHub `main` 分支自动构建**（GitHub 上可见 `Workers Builds: biff-scheduler` 检查）。
> 旧的 **Cloudflare Pages** 项目 `biff-scheduler.pages.dev`（账号 `c591765d…`）**已不在访问链路上**，
> 不要再 `wrangler pages deploy` 直传 —— 传上去也没有人访问（排查方式：Pages 的 HTML 响应带
> `access-control-allow-origin` / `referrer-policy` / `content-type: text/html; charset=utf-8` 三个默认头，Workers 静态资源没有）。

**改代码前建议先读**：[`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md)（数据契约 / 弹层交互 / 渲染约定 / 基础设施踩坑）与 [`PLAN.md`](./PLAN.md)（当前状态与决策记录）。

---

## 八、项目能力（Skills）

仓库的 `skills/` 目录把**可复用的开发能力**固化下来，随代码版本化 —— 每份 skill 是一份 `SKILL.md`（可选 `scripts/`），写清「何时用、怎么做、踩过哪些坑」。索引见 [`skills/README.md`](./skills/README.md)。

| Skill | 用途 | 何时触发 |
|---|---|---|
| [`biff-catalogue-pdf-to-schedule`](./skills/biff-catalogue-pdf-to-schedule/SKILL.md) | BIFF 官方 Catalogue PDF → `schedule.json` / `venues.json` / `films.json` | 换届、更新排期、导入影片目录 |
| [`cloudflare-pages-d1-deploy`](./skills/cloudflare-pages-d1-deploy/SKILL.md) | Cloudflare 部署（非交互模式）；**D1 / Functions 已于 2026-09-11 退役，现役部署 = 推 `main` 触发 Workers Builds**，本 skill 只剩静态产物核对部分 | 首次建站、自动构建异常 |
| [`parallel-agent-safe-commit`](./skills/parallel-agent-safe-commit/SKILL.md) | 多会话并行时只提交自己的改动（blob 手术 + 隔离 worktree 部署） | 提交前发现工作区有他人在途改动 |
| [`web-ui-headless-interaction-qa`](./skills/web-ui-headless-interaction-qa/SKILL.md) | playwright-core 无头交互验收（DOM 断言） | 改完交互要证据、部署后验证线上 |
| [`tailwind-v4-built-css-verify`](./skills/tailwind-v4-built-css-verify/SKILL.md) | 核对 Tailwind v4 类是否真的进了构建产物 | 改完样式确认是否生效 |

**怎么用**：人直接读对应 `SKILL.md`；AI 助手把它作为上下文或按 frontmatter `description` 触发。

> IDE 的 skill 自动加载只认用户级目录（本机为 `~/.workbuddy/skills/`）。`skills/` 是**权威副本**；需要自动触发时把改动同步到用户级目录即可。

---

## 九、数据从哪来（部署时**不需要**解析 PDF）

**一句话**：部署链路与解析脚本无关。运行时数据就是仓库里的静态 JSON，它们**已经检入 git**，`npm run build` 时被 Vite 原样拷进 `apps/web/dist/`，前端 `data.ts` 用 `fetch("schedule.json")` 加载。

| 文件 | 内容 | 由谁产出 |
|---|---|---|
| `apps/web/public/schedule.json` | 全部场次（时间 / 影院 / GV / 分级 / 字幕 / 片长…） | **`tools/scrape_biff_web.py`（抓 biff.kr 官网排期页，2026 起的口径）** |
| `apps/web/public/venues.json` | 影厅清单（厅 id / 影院 / 分区 / 官方代码） | 同上 |
| `apps/web/public/films.json` | 影片目录（片名 / 单元 / 年份 / 国家 / 导演 / 豆瓣分） | `tools/build_films.py`（官方影片信息 **xlsx**） |
| `apps/web/public/douban.json` | 豆瓣映射（**场次 code 与影片 `f###` 双键** → subject_id / 中文名 / 条目链接；**可为空**） | **`tools/build_douban_map.py`**（豆瓣官方 API，检索 `search/suggestion` + 详情 `movie/{id}` 确认） |
| `apps/web/public/douban-related.json` | 豆瓣相关电影（subject_id → `/recommendations` 精简列表；**可为空**） | **`tools/build_douban_related.py`**（对已映射 subject 拉 Frodo 推荐；「是否本届」前端对照 mappings 现查） |
| `apps/web/public/douban-intros.json` | 豆瓣简介（subject_id → intro；**可为空**） | **`tools/build_douban_intros.py`**（对已映射 subject 拉 `movie/{id}` 的 intro） |
| `apps/web/public/festival-extras.json` | 官网「排期之外」的辅助信息：**开票批次 / 票价 / 购票须知**（Booking Information）、**节目嘉宾**（Master Class / Actors' House / Cine Class / Special Talk）、**开闭幕式红毯时间表 + 交通管制** | **`tools/scrape_biff_extras.py`**（抓 biff.kr 官网 `page_num=11402` / `11218` / `11219` / `11366` / `11226` / `11223` / `11233`；只保留 `schedule.json` 里真实存在的 code，自动滤掉往届遗留条目） |

### 两条排期管线：官网抓取（现役）与 Catalogue PDF（历史）

| | 官网抓取 | Catalogue PDF |
|---|---|---|
| 工具 | `tools/scrape_biff_web.py` | `tools/extract_schedule.py` + `tools/import_schedule_2025.py` |
| 输入 | `biff.kr/eng/html/schedule/date.asp?day1=6..15` | 官方 Ticket Catalogue PDF 的排期页 |
| 时效 | **实时** —— 付印后的加场 / 改时间 / 换厅都能拿到 | 付印版，之后的变化看不到 |
| 片长 | 官网排期页**不印**，按影片详情页 `prog_view.asp` 逐部回填（活动场次取活动页的时间区间） | 直接印在格子里 |
| 届次 | 2026（第 31 届）| 2025（第 30 届）|

```bash
# 影片目录（含海报对齐）
python tools/build_films.py --xlsx <影片信息.xlsx> --out apps/web/public/films.json \
    --enriched data/enriched_douban.json --posters-dir apps/web/public/posters

# 海报下载（豆瓣图床有 Referer 防盗链,外链必 418 → 必须离线抓下来随站点部署）
python tools/fetch_posters.py --enriched data/enriched_douban.json --out-dir apps/web/public/posters

# 官网抓取（现役口径）
python tools/scrape_biff_web.py --out-dir /tmp/biff2026 --films-json apps/web/public/films.json
cp /tmp/biff2026/{schedule.json,venues.json} apps/web/public/

# 豆瓣映射（官方 API；只写「片名命中 + 年份不矛盾」的高置信条目，其余留空走搜索兜底）
python tools/build_douban_map.py --films apps/web/public/films.json --out apps/web/public/douban.json --delay 3

# 豆瓣相关电影（对已映射 subject 拉 /recommendations；缺文件前端不报错）
python tools/build_douban_related.py --delay 3

# 豆瓣简介（详情弹层；缺文件不占位）
python tools/build_douban_intros.py --delay 3

# TMDB 海报（token 只从环境变量读，见 .env.example；不要把密钥写进仓库）
python tools/fetch_tmdb_posters.py
```

自检会打印：场次总数 / 编号唯一性 / 厅数 / GV 与联映块数量 / **估算片长清单** / **目录匹配率**。

### 两个已知的数据缺口（都在自检里明示，不静默糊过去）

1. **片长有 9 条是估算值**：开闭幕式、6 场「获奖片重映」、BAFA 毕业典礼 —— 官网既无详情页也无时间区间，
   统一按 120min 兜底并逐条列出。其余 741 场片长均来自官方详情页。
2. **片名桥接 92%**：官网给的是**英文名 + 韩文名**，`films.json` 给的是**中文名 + 原始名**。
   排期侧按 `title_en` 回灌 `films.json` 的中文名（`build_title_index` 收 `title_en` 键），
   再叠加人工别名表 `data/title-alias-2026.json`（87 条）—— 750 场里 **693 场**拿到中文名。
   剩下 57 场本就没有单一中文片名：27 个联映块（`Midnight Passion 1` / `Korean Short Film
   Competition 2`）、活动场（`Actors' House` / `Master Class` / `Cine Class`）与开闭幕 / 颁奖场。
   这些场次 `title_zh` 留空，前端按「纯排期片」单独成条 —— 不会串片。
   · 影片库侧 `apps/web/public/films.json` 246 部里 **244 部**有中文名（余下 `PARADISE LOST` /
   `Melancholia` 目录里本就没有）。配对口径见 `tools/film_match.py` 文件头。

所以：**clone 下来直接 `npm run build` 就有完整数据**（推 `main` 即自动部署），不需要 Python、不需要 PDF、不需要任何解析步骤。

### 什么时候才需要 PDF

只有当你要**换一届 / 更新数据**时。官方 Catalogue PDF **不在仓库里**（体积 + 版权），需自行从 [biff.kr](https://www.biff.kr/) 下载。管线是**本地一次性**跑的，产物检入仓库，不入部署：

```bash
# 0) 依赖（本机 Python 3）
pip install pymupdf openpyxl

# 1) 排期：Catalogue PDF 的排期表页 → schedule.json / venues.json
python tools/extract_schedule.py \
    --pdf <Catalogue.pdf> --year 2025 --month 9 \
    --out /tmp/schedule.json --venues-out /tmp/venues.json

# 2) 收尾：泳道按「分区 → 影院 → 厅号」重排 + festival 元信息 → apps/web/public/
python tools/import_schedule_2025.py \
    --schedule /tmp/schedule.json --venues /tmp/venues.json --dest public

# 3) 影片目录（二选一）
python tools/build_films.py --xlsx <影片信息.xlsx> --out apps/web/public/films.json        # 有官方 xlsx 时优先
python tools/extract_films_2025.py --pdf <Catalogue.pdf> --out apps/web/public/films.json  # 否则抽 PDF 介绍页

# 4)（可选）豆瓣映射慢速回填（产物填进 apps/web/public/douban.json 的 mappings）
python tools/enrich_douban.py --xlsx <影片信息.xlsx> --out data/enriched_douban.json          # 有 xlsx
python tools/enrich_douban.py --films-json apps/web/public/films.json --out data/enriched_douban.json  # 只有 PDF 产物
```

### 不想跑 Python 也行

`apps/web/public/*.json` 就是普通 JSON，按 `apps/web/src/types.ts` 里的契约手改或自己造即可 —— `data.ts` 还会做兜底归一（跨午夜时间补 24h、韩文片名兜底等），旧版 JSON 也能自愈。

### 现有数据的届次

- **2026（第 31 届）**：官网排期页 + 影片信息 xlsx —— **750 场 / 26 厅 / 10 天（10/6–10/15）/ 250 部影片**（**当前仓库内置**）；中间产物另存 `data/schedule-2026.json` · `data/venues-2026.json` · `data/film-meta-2026.json`
- **2025（第 30 届）**：Catalogue PDF —— 排期页 p9–p16、影片介绍页 p22–p97；699 场 / 29 厅 / 10 天（9/17–9/26）/ 224 部影片（已换下，git 历史可查）

### 解析能力的代码分工

| 文件 | 角色 |
|---|---|
| `tools/festival_common.py` | **通用底座** —— 页面拆 line / 版面几何选择器 / META 扫描 / 自检哨兵 / JSON 写出（与电影节无关） |
| `tools/extract_schedule.py` | **BIFF 适配层** —— 场馆表 / token 正则 / 版面几何 / 午夜联映块 |
| `skills/biff-catalogue-pdf-to-schedule/SKILL.md` | **操作手册** —— 19 条版面陷阱、自检基线、换年份适配清单 |

新增其他电影节（HKIFF / PYIFF 等）：复制适配层 → 替换 `VENUE_NAME` / `RE_*` / `LAYOUT` / `META_SYNTAX` 与特殊板块 → 另建一份独立 SKILL。可复用边界与完整步骤见该 SKILL 的「新增电影节」一节。

---

## 十、数据说明与许可

- 排期 / 场次信息来源于 biff.kr 公开页面，**仅作个人非商用排片参考**，不收费、不对外分发；页脚已保留出处归属。
- `apps/web/public/brand/` 下的 BIFF 官方 logo 素材（favicon / 字标 / ft_logo）版权归 BIFF 组委会所有，**如转为商业或公开大规模用途，需移除并替换为自有设计**。
- 影片目录源为电影节官方影片信息表；豆瓣评分来自该表的评分列，豆瓣条目链接由 `tools/enrich_douban.py` 离线慢速回填，缺失即走搜索跳转。
- 登录使用 HttpOnly 会话 Cookie。访客片单保存在浏览器；登录并选择同步后，账号片单存入独立 D1。显示名称、头像和简介由 IFFDAY 账号系统管理。

**Unofficial fan tool, not affiliated with Busan International Film Festival.**
