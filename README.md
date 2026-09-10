# BIFF Scheduler · 釜山电影节排片工具

把[釜山国际电影节](https://www.biff.kr/)的官方排期表，变成一张**可点选的甘特网格**：
选片 → 冲突检测 → 双方案（A/B）对比 → AI 智能排片 → 导出 `.ics` 进手机日历 → 一键跳豆瓣。

个人自用、单用户、零服务器成本。前端无框架手写，数据本地优先、云端尽力同步。

> **当前状态**：核心链路（排片网格 / 冲突检测 / 行程 / 选片 / 影片库 / AI 智能排片 / `.ics` 导出 / 豆瓣映射）均已实现并部署冒烟通过。
> 仓库内置的是**第 30 届（2025）真实排期数据**（699 场 / 29 厅 / 7 家影院 / 10 天）作为开发与联调基线；
> 2026 第 31 届官方排期发布后，用离线管线重新解析灌入 `public/*.json` 即可切换，前端代码零改动。

---

## 一、这是什么

一个「一个人的电影节排片工作台」。电影节的官方排期是一张巨大的 PDF 表格（影院 × 时间），人工看片、排时间、算转场、防撞场非常痛苦。这个工具把它变成：

- 一张**横向时间轴 × 纵向影厅**的甘特网格，点一下就加入行程；
- 自动检测**同一方案内**的时间重叠与跨馆转场余量；
- 支持 **A / B 两套方案**并行对比（比如「贪心看最多」vs「只看必看」）；
- 可以把「想看的片 + 档位（必看/备选/随缘）+ 时间偏好」交给 **AI**，让它排出一份候选行程，本地复检冲突后再并入；
- 一键导出标准 `.ics`，直接进 iOS/Android 日历（含提醒），并生成一张**抢票顺位清单**。

---

## 二、快速开始

### 在线使用（已部署）

打开 **https://biff-scheduler.pages.dev** 即可。无需注册、无鉴权；站点已在 `robots.txt` 里禁止收录，仅个人自用。

### 本地运行

```bash
npm install
npm run dev          # 本地开发服务器（Vite）
npm run preview      # 构建后用 wrangler 起本地 Pages + Functions + D1 环境
```

> `npm run preview` 才能连上 `/api/*` 与 D1；单纯 `npm run dev` 时接口不可用，前端会自动降级为「纯本地模式」（数据只落 localStorage）。

---

## 三、使用指南（详细）

### 1. 顶栏

| 控件 | 作用 |
|---|---|
| **A 方案 / B 方案** | 切换当前正在编辑的方案。选片、行程、冲突检测、导出都按「当前方案」生效；两套方案互不干扰 |
| **同步状态点** | 绿点 = 云端（D1）已连通；异常时数据仍会先落本地，恢复后自动补推 |
| **⚠ 冲突角标** | 当前方案存在冲突时出现，点它平滑滚动到「我的行程」 |
| **影片库** | 打开全部影片目录（搜索 / 筛选 / 打标 / 展开场次） |
| **我的选片** | 打开「按片看」的选片总览（与「我的行程」同一份数据） |
| **导出 .ics** | 下拉菜单：导出 A 方案 / B 方案 / A+B 全部 / 抢票顺位清单（复制） |
| **设置** | 提醒提前量、跨馆转场缓冲、GV 映后谈默认、AI Key 状态、清空场次 |

### 2. 排片网格（甘特）

- **日期快捷条**：顶部一排日期 chip，点选切换当天；标题右侧显示当日场次数。
- **点选加入 / 移出**：点击任意场次卡片即加入当前方案（整卡淡绿底）；再点一次移出。已加入的卡片会带上该片的**档位色点**（蓝=必看 / 紫=备选 / 灰蓝=随缘）。
- **状态配色**（三套互相独立）：
  - **红**：同方案内两场放映时间重叠 → 整卡红底红框 + ⚠；
  - **黄**：同方案相邻两场衔接偏紧（间隔小于转场缓冲，或余量不足 15 分钟）→ 整卡淡黄底；hover 卡片可看到完整算式；
  - **绿**：已加入当前方案。
- **跨馆转场余量（gap-bar）**：相邻两场之间若需跨影院，会显示余量条，三态 `ok / tight / bad`。
- **双向 hover 联动**：鼠标移到网格卡片上，同一冲突组与「我的行程」里对应的行会一起高亮；反向亦然。
- **缩放**：`− / +` 沿离散阶梯缩放（影厅列宽、时间刻度、卡片字号同倍率伸缩），「适应」把当天整条时间轴塞进视口，「1:1」回到基准比例。缩放是纯视图偏好，会自动记忆。
- **行标签**：左侧粘性列显示官方影院代码 chip（`B1` / `BT` / `L10`…），整格 hover 出全名 / 韩名 / 分区。
- **场次徽章**：观影等级（ALL/12/15/19）、字幕/对白标识（KE/KN/KK/NO）、节目册页码、片长、GV / Masterclass / Premiere 等，均以小徽章渲染，每枚 hover 即说明；顶部「ⓘ 日程表说明」打开字段总览图例。

### 3. 我的行程

- 按日期分组的议程列表，只显示**当前方案**已排的场次。
- 行内三段分段控件可即时切换该片的档位（必看 / 备选 / 随缘）—— 档位在**影片级**，改一处，网格卡片与「我的选片」同步。
- **✕** 只移除该场（选片意向保留，该片仍留在「我的选片」里，标为「未排场」）；只有「档位未设 + 无备注 + 最后一场」才会整条删除。
- **⏱ N′ 胶囊**：GV 场次可单独覆写映后谈时长 / 是否参加（留空 = 跟随全局默认）。
- 头部显示当前方案场次数、冲突数，以及一个**排片质量分**药丸（综合档位覆盖、冲突、转场余量的本地评分）。

### 4. 我的选片

- 「按片看」的总览视图：一部片一条记录，显示档位、已排场次、备注。
- 可筛选、切换档位、点「定位 ▸」跳到网格并闪烁高亮、或整片移除。
- 与「我的行程」是**同一份数据的两个视图**，永远一致。

### 5. 影片库

- 浏览全部影片目录（2025 基线约 224 部），支持搜索：中文名 / 原始片名 / 场次 code / 单元 / 导演。
- **单元筛选 chips**：按单元（主竞赛 / Icons / 亚洲电影之窗…）快速收窄。
- **行内展开场次**：每部片展开后列出它的所有场次，可直接加入 / 移出当前方案。
- **打标**：给影片点「必看 / 备选 / 随缘」（再点一次取消 → 回到「未设」）。
- **定位 ▸**：跳到网格对应日期并滚动闪烁到该场。
- **资料 ⓘ**：打开影片资料弹层（元信息 + 豆瓣条目关联）。
- 顶部有「**智能排片**」入口，直接带着当前片单进入 AI 面板。

### 6. 智能排片（AI）

> **隐私承诺**：API Key 只保存在你本机浏览器的 `localStorage`，请求由浏览器**直连**你填的模型服务商（OpenAI 兼容 `/chat/completions`）。本站**没有**任何 LLM 代理端点，Key 不会进入任何发往本站的请求，界面只显示掩码。

面板四步：

1. **① 填入你自己的模型 API Key** —— 选服务商（自动预填 Base URL 与模型名，均可改），填 Key，「保存到本机」。也可在设置里清除。
2. **② 排哪几天** —— 日期 chips（记住上次选择）。只有选中日期的场次会送给模型，收窄日期 = 直接减少上下文与费用；配合「并入」可以一天天排、累积进同一方案。
3. **③ 你的排片偏好（可选）** —— 自然语言，例如：
   > `21 号 17:00 开始看、看到最晚那场（含跨午夜）；上午不看；只看 BCC；每部片优先选带 GV 的场`
   口语化时间会被自动归一（「下午五点」= 17:00）。不填也行，会按评分与 GV 优先挑一份紧凑行程。
4. **④ 开始 AI 排片** —— 生成中可随时点击中断。

结果与采纳：

- 模型返回 **1~3 个候选方案**（按贴合你优先级的程度排序），每个方案一张**可折叠卡**，附「未纳入影片 + 原因」。
- 每个方案都有独立的「**并入 A / 并入 B**」：这是**追加合并**（不覆盖、不清空、幂等），会自动剔掉「该片已在目标方案有场次 / code 重复 / 时段冲突」的场次，并回执「加了 N 场 · 跳过 M 场」。
- 返回结果**一律本地复检**（code 白名单 → 同片去重 → 复用冲突检测算法），不信任模型的自我约束。
- **无片单模式**：一部片都没打标也能排 —— 候选池退化为「全部有排期的影片」，怎么排完全由偏好文字决定，并入后档位记为「未设」。
- **强制无片单模式**：已打过标时，可勾选开关忽略已打标影片，让 AI 完全自由选。

### 7. 导出与抢票

- **`.ics` 导出**：标准 iCalendar，时间一律 UTC，`UID = <code>@biff-2026`，含相对提醒（默认提前 45 分钟，可在设置改）、场馆、方案与档位、豆瓣链接。导入手机日历后按手机时区显示。
- GV 场次的结束时间会按「是否参加映后谈」动态计算，`.ics` 与冲突检测口径一致。
- **抢票顺位清单（复制）**：按「必看 → 备选 → 随缘」排序的纯文本清单，附场次时间与场馆，方便售票时段按顺位抢票。

### 8. 豆瓣映射（半自动）

- 影片资料弹层里可「拼搜索链接 → 打开豆瓣 → 粘贴条目链接回填」，解析出 `subject_id` 与中文名并存入云端映射表。
- 映射成功后，影片库与卡片上会显示**豆瓣评分徽章**，`.ics` 描述里也会带上豆瓣链接。
- 不做爬虫（豆瓣必撞 CAPTCHA），只做链接跳转 + 粘贴回填。

### 9. 设置

| 设置项 | 说明 |
|---|---|
| 提醒提前量 | `.ics` 闹钟提前分钟数（建议 30–60） |
| 跨场馆转场缓冲 | 判定跨影院场次冲突所需的余量（同影院不受影响；默认 0 = 仅判时间重叠） |
| GV 映后谈默认 | 全局默认是否参加 + 默认时长（分钟）；单场可在行程里覆写 |
| AI 排片 · 模型 API Key | 只读状态 + 清除（填写/更换入口在「影片库 ▸ 智能排片」） |
| 清空全部已排场次 | 只清 A+B 的场次，**保留**选片意向（档位），清完仍可一键智能排片 |

---

## 四、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 构建 | **Vite 6** | 输出到 `dist/`，`base: "./"`；`public/*.json` 原样拷贝进产物根目录 |
| 语言 | **TypeScript 5** | 全量类型标注，`tsc --noEmit` 作为构建前置门禁 |
| 前端框架 | **无** | 手写 TS + DOM，网格 / 冲突 / 徽章 / 弹层栈 / 甘特缩放全部自研；未引入任何组件库 |
| 样式 | **Tailwind CSS v4**（`@tailwindcss/postcss`） | **增量双轨**：不引 preflight，存量语义类读设计 token，新 UI 用 utility；token 是唯一色源 |
| 部署 | **Cloudflare Pages** | 静态产物 + Pages Functions，全球边缘分发，零服务器成本 |
| 后端 | **Cloudflare Pages Functions** | `functions/api/**` 动态路由（Workers runtime），提供选片 / 映射读写 |
| 数据库 | **Cloudflare D1**（SQLite） | 存用户选片与豆瓣映射；`user_id` 字段预留多人 |
| 运维 | **Wrangler 4** | 本地预览、D1 迁移、Pages 部署 |
| 离线管线 | **Python**（PyMuPDF / openpyxl）+ Node 脚本 | 从官方 Ticket Catalogue PDF 与影片信息 xlsx 解析出 `schedule.json` / `venues.json` / `films.json`；产物检入仓库，**仅在更新数据时需要**，部署链路不依赖它 |

**为什么这么选**：单用户自用工具，追求零成本与零重依赖。网格对交互定制要求高（冲突联动、跨午夜 24+ 时制、缩放锚点），现成组件库要么付费、要么样式难融、要么体积过大 —— 自研反而更小更可控。

---

## 五、架构与数据流

```
离线数据管线（本机 Python / Node，非部署部分）
  官方 Ticket Catalogue PDF / xlsx
    └─ tools/*.py ──► public/schedule.json · venues.json · films.json（只读、版本化、可 diff）

在线应用（Cloudflare Pages + Functions + D1）
  dist/（Vite 构建产物）      functions/api/            D1（SQLite）
  ├─ schedule.json（只读排期） ├─ pick.js                ├─ user_pick（我的选片，影片级）
  ├─ venues.json（只读场馆）   ├─ pick/[key].js           └─ douban_map（豆瓣映射）
  ├─ films.json（只读目录）    ├─ mapping.js
  └─ assets/（main.ts 打包）   └─ mapping/[code].js
```

**数据分层原则**：官方排期 = 只读静态 JSON（前端按 code 反查权威数据，版本化、可 diff）；用户数据 = D1（本地优先，云端尽力同步，接口不可用自动降级本地）。

**核心数据模型**：全站唯一数据源是「**一部片一条记录**」（`film_key → { priority, picks[], note }`）。

- 档位在**影片级**（一部片只有一个档位）；
- 场次归属在**场次级**（同一部片的两场可以分别放进 A / B 方案）；
- 「我的选片」（按片看）与「我的行程」（按场次看）是这份数据的两个视图，永不打架。

**前端模块（`src/`）**

| 文件 | 职责 |
|---|---|
| `main.ts` | 装配 + 全局事件委托 + 设置 / 导出 / 抢票清单 / 双向 hover 联动 |
| `state.ts` | 全局 store、localStorage ↔ D1 双向同步、派生索引与订阅 |
| `grid.ts` | 甘特排片网格（时间轴、粘性影厅列、缩放锚点、gap-bar） |
| `agenda.ts` | 我的行程列表 |
| `library.ts` | 影片库 + 我的选片 + 智能排片弹层 |
| `ai.ts` | 隐藏主 Prompt（硬约束 C1–C6）、打包、调用、输出校验（纯逻辑，不碰 DOM） |
| `engine.ts` | 排片质量分 |
| `conflict.ts` | 纯函数冲突检测（转场余量可注入） |
| `ics.ts` | `.ics` 生成（UTC、跨午夜进位、GV 映后） |
| `gv.ts` | GV 映后谈时长 / 是否参加的统一解析口径 |
| `badges.ts` / `legend.ts` | 场次徽章注册表 / 图例与场馆说明 |
| `modal.ts` | 弹层栈（开新层压住下层、返回恢复滚动与筛选态） |
| `pick.ts` | 档位语义 / 配色 / 分段控件的共享层 |
| `data.ts` / `api.ts` / `tip.ts` / `types.ts` / `util.ts` | 数据加载与归一 / D1 API 客户端 / 悬停提示 / 类型 / 工具 |

**API**

```
GET    /api/pick            → 我的全部选片（影片级）
PUT    /api/pick/:key       → upsert { priority(must|maybe|wild|null), note, picks:[{code,group}] }
DELETE /api/pick/:key       → 删除一条选片记录
GET    /api/mapping         → 豆瓣映射全量
PUT    /api/mapping/:code   → { douban_url | subject_id }
```

---

## 六、目录结构

```
├─ index.html              # 单页入口
├─ src/                    # 前端 TS 源码（见上表）
├─ functions/api/          # Pages Functions：pick、mapping 动态路由
├─ migrations/             # D1 迁移：0001_init / 0002_priority_nullable / 0003_user_pick
├─ public/                 # 静态数据：schedule.json / venues.json / films.json / brand/ / robots.txt
├─ tools/                  # 离线数据管线（Python / Node，不入部署）
├─ data/                   # 离线中间产物（enriched_douban.json、films-2026.json 等）
├─ docs/                   # CONVENTIONS.md（工程约定）+ plans/（逐需求 PLAN）+ history/
├─ PLAN.md                 # 活文档：当前状态 / 决策 / 待办 / 架构
└─ dist/                   # 构建产物（部署目录）
```

---

## 七、开发与部署

```bash
npm install

npm run dev                 # 本地开发（Vite，无 Functions）
npm run typecheck           # tsc --noEmit
npm run build               # typecheck + vite build
npm run preview             # 构建 + wrangler pages dev dist（含 Functions + 本地 D1）

# 部署（首次需先创建 D1 与 Pages 项目，见 PLAN.md）
npm run migrate:remote      # wrangler d1 migrations apply biff-scheduler-db --remote
npm run deploy              # 构建 + wrangler pages deploy dist（production 分支）
```

**改代码前建议先读**：`docs/CONVENTIONS.md`（数据契约 / 弹层交互 / 渲染约定 / 基础设施踩坑）与 `PLAN.md`（当前状态与决策记录）。

---

## 八、数据从哪来（部署时**不需要**解析 PDF）

**一句话**：部署链路与 PDF 无关。运行时数据就是仓库里的三个静态 JSON，它们**已经检入 git**，`npm run build` 时被 Vite 原样拷进 `dist/`，前端 `data.ts` 用 `fetch("schedule.json")` 加载。

| 文件 | 内容 | 由谁产出 |
|---|---|---|
| `public/schedule.json` | 全部场次（时间 / 影院 / GV / 分级 / 字幕 / 页码…） | `tools/extract_schedule.py`（解析官方 Catalogue **PDF** 的排期页） |
| `public/venues.json` | 影厅清单（厅 id / 影院 / 分区 / 代码） | 同上 |
| `public/films.json` | 影片目录（片名 / 单元 / 年份 / 国家 / 导演 / 豆瓣分） | `tools/build_films.py`（官方影片信息 **xlsx**）或 `tools/extract_films_2025.py`（PDF 影片介绍页） |

所以：**clone 下来直接 `npm run build` + `npm run deploy` 就有完整数据**，不需要 Python、不需要 PDF、不需要任何解析步骤。

### 什么时候才需要 PDF

只有当你要**换一届 / 更新数据**时。官方 Catalogue PDF **不在仓库里**（体积 + 版权），需自行从 [biff.kr](https://www.biff.kr/) 下载。管线是**本地一次性**跑的，产物检入仓库，不入部署：

```bash
# 0) 依赖（本机 Python 3）
pip install pymupdf openpyxl

# 1) 排期：Catalogue PDF 的排期表页 → schedule.json / venues.json
python tools/extract_schedule.py \
    --pdf <Catalogue.pdf> --year 2025 --month 9 \
    --out /tmp/schedule.json --venues-out /tmp/venues.json

# 2) 收尾：泳道按「分区 → 影院 → 厅号」重排 + festival 元信息 → public/
python tools/import_schedule_2025.py \
    --schedule /tmp/schedule.json --venues /tmp/venues.json --dest public

# 3) 影片目录（二选一）
python tools/build_films.py --xlsx <影片信息.xlsx> --out public/films.json        # 有官方 xlsx 时优先
python tools/extract_films_2025.py --pdf <Catalogue.pdf> --out public/films.json  # 否则抽 PDF 介绍页

# 4)（可选）豆瓣评分慢速回填
python tools/enrich_douban.py
```

### 不想跑 Python 也行

`public/*.json` 就是普通 JSON，按 `src/types.ts` 里的契约手改或自己造即可 —— `data.ts` 还会做兜底归一（跨午夜时间补 24h、韩文片名兜底等），旧版 JSON 也能自愈。

### 现有数据的届次

- **2025（第 30 届）**：Catalogue PDF —— 排期页 p9–p16、影片介绍页 p22–p97；699 场 / 29 厅 / 10 天（当前仓库内置）
- **2026（第 31 届）**：影片目录已暂存 `data/films-2026.json`；官方排期发布后用同一套管线解析即可切换，**前端代码零改动**

---

## 九、数据说明与许可

- 排期 / 场次信息来源于 biff.kr 公开页面，**仅作个人非商用排片参考**，不收费、不对外分发；页脚已保留出处归属。
- `public/brand/` 下的 BIFF 官方 logo 素材（favicon / 字标 / ft_logo）版权归 BIFF 组委会所有，**如转为商业或公开大规模用途，需移除并替换为自有设计**（详见 `PLAN.md` §8）。
- 影片目录源为电影节官方影片信息表，豆瓣评分由 `tools/enrich_douban.py` 慢速回填，缺失即不展示。
- 本站不使用 Cookie 追踪、不做用户画像；用户数据仅存于本地浏览器与你自己的 D1 数据库。

**Unofficial fan tool, not affiliated with Busan International Film Festival.**
