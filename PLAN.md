# 电影节排片工具（BIFF Scheduler）— 实施计划

> 目标：给「自己」用的釜山电影节（BIFF）排片工具 —— 解析官方 Ticket Catalogue PDF → 可视化选片排期 → 冲突检测 → 导出 .ics 进手机日历 → 一键跳豆瓣。
> 架构复用已验证的 Cloudflare 零成本流水线（Pages + D1 + Functions，同 fuwafuwa），单用户、无服务器成本。
> 版本：v1（PLAN）｜更新：2026-09-09

---

## 0. 核心定位与设计原则

| 原则 | 决定 |
|---|---|
| 数据流分离 | PDF 解析是**离线一次性管线**（本机 Python），产出的 `schedule.json` 随部署走静态资源；**线上不做爬取/解析** |
| 只读数据 vs 用户数据 | 官方排期=只读、每届固定 → 静态 JSON（版本化、可 diff）；用户排片/豆瓣映射=可写 → D1 |
| 免费优先 | FullCalendar 的 Resource View（影院×时间网格）是 **Premium 付费插件** → 排片网格自研（CSS Grid），免费的 FullCalendar 仅用于"我的行程"日视图 |
| 单用户 | 无登录体系；预留 `user_id` 字段便于将来分享给朋友 |
| 半自动豆瓣 | 不做爬虫（触发 CAPTCHA），前端拼搜索链接 + 用户粘贴链接回填映射 |

---

## 1. 系统架构总览

```
┌─ 离线数据管线（本机 Mac, 每次影展跑一遍, 非部署部分）─────────────────────┐
│                                                                        │
│  BIFF Ticket Catalogue.pdf                                             │
│    │  pdfplumber(Lattice表格)  → Camelot(兜底) → LLM视觉(残差页兜底)      │
│    ▼                                                                   │
│  extract_schedule.py  清洗/归一化                                        │
│    · venue 名称归一化(别名→master)   · 时间解析(KST)                     │
│    · GV/映后 识别 → end_time = start + duration(+25min if GV)          │
│    ▼                                                                   │
│  schedule.json (排期) + venues.json (影院/坐标) + films.json (影片去重)   │
│    ▼ 校验脚本 validate_schedule.py (schema + 时间冲突自检)              │
└────────────────────────────────────────────────────────────────────────┘
                              │ 检入仓库
                              ▼
┌─ 在线排片应用（Cloudflare Pages + Functions + D1）──────────────────────┐
│  public/                    functions/api/           D1 (SQLite)      │
│  ├ index.html(单页)          ├ plan.js               ├ user_plan       │
│  ├ schedule.json ──────────► ├ mapping.js            └ douban_map      │
│  ├ venues.json                └ (中间件预留 PIN)                        │
│  └ assets/(打包产物)                                                        │
│    前端模块: 排片网格 / 行程视图(FullCalendar free) / .ics生成 / 豆瓣跳转  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 项目初始化（阶段 0，半天内可完成骨架）

新目录 `biff-scheduler/`，结构：

```
biff-scheduler/
├─ wrangler.toml            # name=biff-scheduler; D1 binding; pages_build_output_dir=./public
├─ package.json             # 仅前端构建依赖: vite + fullcalendar(core/timegrid/interaction)
├─ migrations/0001_init.sql # user_plan / douban_map 建表
├─ public/                  # 构建产物 + 数据: index.html, schedule.json, venues.json
├─ src/                     # TS 源码(vite 构建到 public/assets)
│   ├─ main.ts / grid.ts / plan.ts / ics.ts / douban.ts / api.ts / types.ts
├─ functions/api/
│   ├─ plan.js              # GET/PUT/DELETE 我的排片
│   └─ mapping.js           # GET/PUT 豆瓣映射
└─ tools/                   # 离线数据管线(Python, 不进部署)
    ├─ requirements.txt     # pdfplumber, camelot-py[base]?, pandas
    ├─ extract_schedule.py
    ├─ build_venues.py
    └─ validate_schedule.py
```

### wrangler.toml 要点（照搬 fuwafuwa 已验证配置）

```toml
name = "biff-scheduler"          # Pages 项目名账户内唯一；URL 仍会是 <name>-<随机hash>.pages.dev
compatibility_date = "2026-09-09"
pages_build_output_dir = "./public"

[[d1_databases]]
binding = "DB"
database_name = "biff-scheduler-db"
database_id = "<d1 create 后填入>"
migrations_dir = "./migrations"
```

> 复用 skill `cloudflare-pages-d1-deploy`：先 `wrangler d1 create` → `d1 migrations apply --remote` → `pages project create`（首次 deploy 必须预创建）→ `pages deploy public --project-name biff-scheduler --branch production --commit-dirty=true`。
> 国内访问 `*.pages.dev` 不稳，但届时人已到釜山，网络无碍；若介意可后续绑自有域名。

### D1 Schema（0001_init.sql）

```sql
CREATE TABLE IF NOT EXISTS user_plan (
  user_id    TEXT NOT NULL DEFAULT 'me',   -- 预留多人
  code       TEXT NOT NULL,                -- 排片单场次 code(3位, 唯一主键)
  group_tag  TEXT NOT NULL DEFAULT 'A',    -- 'A'|'B' 双方案
  priority   TEXT NOT NULL DEFAULT 'maybe',-- must|maybe|wild(必看/备选/随缘)
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, code)
);

CREATE TABLE IF NOT EXISTS douban_map (
  code        TEXT NOT NULL PRIMARY KEY,
  subject_id  INTEGER,                     -- 豆瓣条目 id
  title_cn    TEXT,                        -- 用户/LLM 补的中文片名
  douban_url  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 3. 阶段一：离线数据管线（PDF → JSON）

### 3.1 解析策略（按可靠度递减，逐级兜底）

1. **pdfplumber（首选）**：`extract_tables()` 提取带线框表格，输出 DataFrame 雏形。零外部依赖（纯 Python）。
2. **Camelot Lattice（第二层）**：线框复杂/跨页合并时更稳。⚠️ Lattice 依赖 **Ghostscript**（`brew install ghostscript`），先探测环境。
3. **LLM 视觉兜底（残差页）**：传统库错行严重的页（文字重叠/紧凑），**按页转 PNG 投大模型**，Schema 约束输出 JSON。模型选型待拍板（见 §8 决策 D4）。
4. （可选数据源）若官方出网页版看片表，可直连爬取替代 PDF —— 留作 B 计划。

### 3.2 清洗与归一化规则

- **Venue 别名归一**：PDF 内 `BCC C1` / `Busan Cinema Center 1` / `영화의전당 1` → venues.json 主键 `bcc-1`。维护别名表，抽到未知值 → 提示人工补。
- **时间解析**：一律按 **KST(+09:00)** 处理；`"10/8 11:30"`、`"OCT.8 11:30"` 等格式统一 → ISO。
- **GV / 映后标记**：识别 `GV`/`Guest Visit`/`관객과의 대화` → `is_gv=true`，**结束时间自动 +25min**（可在 UI 按场次覆盖）。
- **输出 Schema**（即用户给定结构，补 `end_time`、`title_zh`、`url`）：

```json
{
  "code": "083",
  "title_en": "Film Name",
  "title_kr": "영화 제목",
  "title_zh": "",                 // 阶段三豆瓣回填
  "date": "2026-10-08",
  "start_time": "11:30",          // KST
  "end_time": "14:10",            // start + duration(+25 if GV)
  "duration_min": 120,
  "venue_id": "bcc-1",
  "venue_display": "Busan Cinema Center Cinema 1",
  "is_gv": true
}
```

### 3.3 校验（跑通才算完成）

- `validate_schedule.py`：schema 全字段校验、code 无重复、时间可解析、venue_id 均存在于 venues.json、**同日同 venue 同时间段无官方重叠**。
- 输出统计：总场次/片数、GV 数、每 venue 场次、异常行清单 —— 打印给人眼抽查。

### 3.4 产出物与验收

- 产出 `schedule.json` + `venues.json` + `films.json` 放入 `public/`（git 版本化，每届可开 tag）。
- 验收：`validate_schedule.py` 零报错；抽 20 条与 PDF 人工比对通过。

---

## 4. 阶段二：核心排片应用（前端 + API）

### 4.1 前端页面（单页 index.html，中文 UI）

| 视图 | 实现 | 说明 |
|---|---|---|
| **选片网格**（默认） | 自研 CSS Grid | 行=影院/厅，列=时间轴；每格一个场次卡片；点击选中/取消加入行程 |
| **我的行程** | FullCalendar **free** timeGridDay | 只展示已选场次，按优先级着色；重叠冲突红色标出；按日切换 |
| **豆瓣 / 详情** | 弹层 | 显示片名/时长/GV/场次清单；跳豆瓣链接 |
| **导出** | 按钮 | 生成 `.ics` 下载（默认 A 方案；可切 B/全部） |
| **设置** | 收起面板 | GV 加时(25min)、提醒提前量(默认45min)、转场缓冲分钟数 |

- 顶部悬浮：日期快捷条（D1~D10）+ 「A/B 方案」切换 + 「导出 .ics」+ 冲突数角标。

### 4.2 冲突检测规则（核心逻辑，纯前端即时算）

```
选片 i 的实际时段 = [start_i, end_i]   // end 已含 GV 加成
两场冲突条件:
  同方案(A或B)内存在 i≠j 且 [start_i, end_i) ∩ [start_j, end_j) ≠ ∅
  → 立刻红框高亮 + 顶部冲突计数
加转场缓冲(阶段三开启后):
  venue_i ≠ venue_j 时, 对 end_i 追加 transit_time(venue_i→venue_j)
  → [end_i + transit, start_j) 需 ≥ 0, 否则标"转场极度紧张"
```
- 允许"明知冲突仍要加"（强加到行程），但冲突项始终视觉标红 —— 工具建议、人做决定。
- 冲突**只针对同一方案内部**；A/B 互不干扰（天然双方案）。

### 4.3 API（Pages Functions，全部走 D1）

```
GET    /api/plan            → 我的全部排片 {code, group_tag, priority, note}
PUT    /api/plan/:code      → body {group_tag, priority, note}   upsert
DELETE /api/plan/:code      → 移除
GET    /api/mapping/:code   → 豆瓣映射(subject_id/url/title_cn)
PUT    /api/mapping/:code   → body {douban_url | subject_id}    服务器正则抽取 /subject/(\d+)/
```

### 4.4 .ics 导出细节（易错点提前钉死）

- 每条选片 = 一个 `VEVENT`，`UID = <code>@biff-2026`，`SUMMARY=[083] 片名 (GV)`，`LOCATION=影院厅`，`DESCRIPTION` 带豆瓣链接/备注。
- **时间**：转 **UTC（Z）** 导出最稳（iCal 客户端自动按设备时区显示）。人在釜山时手机时区=KST 显示即当地时刻；回国内显示会 -1h（可接受，导出面板给一行提示）。
- **提醒**：`BEGIN:VALARM / TRIGGER:-PT45M / ACTION:DISPLAY`，45 分钟可在设置改。
- 单文件一次导出多天（一整个节日的看片计划），供"添加到日历"。

---

## 5. 阶段三：增强功能

### 5.1 豆瓣链接（半自动 + 复用）

1. 无映射 → 点击片名打开 `https://www.douban.com/search?q={title_en}+{导演/年份}`（前端拼 URL，不爬虫）。
2. 详情弹层给"粘贴豆瓣链接"输入框 → 正则抽 `subject_id` → PUT `/api/mapping` 落 D1。
3. 已有映射 → 直接链到 `https://movie.douban.com/subject/{id}/`。
4. 可选：导入期用 LLM 按 title_en/kr 预生成 `title_zh` 候选（决策 D4），渲染时灰字展示，点一下即采纳为中文名。

### 5.2 场馆转场计算

- `venues.json` 预置坐标（BCC/CGV Centum/LOTTE/海云台等）+ 场馆间距经验表。
- 前端 haversine 距离 → 估算分钟数；已知热门对儿（如 CGV Centum ↔ 电影殿堂，相邻）走经验值。用户可在设置里对任意 pair 覆盖。
- 网格内冲突判定叠加转场缓冲（见 §4.2），并提供"两场之间空档 X 分钟（建议 ≥Y）"提示。

### 5.3 抢票 Plan A / Plan B

- 每个场次标记 `priority: must|maybe|wild` + `group_tag: A|B`。
- 顶部 A/B 一键切换；「导出 .ics」按当前方案过滤（B 方案天然是 A 的互斥备选）。
- 冲突检测按方案隔离；必看冲突时提示"本组有 N 处重叠，切 B 方案看是否解决"。

---

## 6. 里程碑与验收（每步可独立交付/回滚）

| 阶段 | 内容 | 交付/验收 |
|---|---|---|
| **M0** | 脚手架 + 部署骨架 | `https://<hash>.pages.dev` 返回占位页；D1 空表可 `GET /api/plan` → `[]` |
| **M1** | 数据管线跑通 | 真实 PDF → `schedule.json` 校验零错、抽样人工比对过 |
| **M2** | 核心排片 + 导出 | 网格选片/冲突红标/我的行程/`.ics` 下载 → 真机 iOS 日历可导入且提醒正确 |
| **M3** | 增强 | 豆瓣跳转+映射复用；转场提示；A/B 方案 |

> M1 依赖官方 Catalogue PDF 发布（历年 9 月中旬～下旬）。**M0/M2 可先用 mock schedule.json 开发联调**，PDF 一出直接跑 M1 灌真数据 —— 不阻塞主链路。

---

## 7. 风险与避坑清单

1. **FullCalendar Resource 视图是付费的** → 网格自研；别在计划里用 Premium 插件。✔ 已在架构规避
2. **首次 `pages deploy` 会卡非交互** → 先 `pages project create`（skill 已记录）
3. **`d1 execute --command` 只跑第一条 SQL** → 迁移用 `d1 migrations apply --remote`
4. **本地调试别传 `--d1` 标志**（会另起一个 sqlite 实例导致 no such table）
5. **Pages 子域名带随机 hash 且不可改** → 自用可接受；介意就绑自有域名
6. **豆瓣爬虫必撞 CAPTCHA** → 只做链接跳转 + 用户粘贴回填，绝不服务器抓豆瓣
7. **ICS 时区坑** → 一律导出 UTC 绝对时间；提醒用相对 TRIGGER
8. **GV 场次时长** → 解析阶段就加 25min 进 end_time，别在前端临时补（保证 .ics 与冲突检测一致）
9. **PDF 表格跨页/错行** → 解析脚本对每页输出"可疑行"清单人工过目，LLM 只兜底残差页
10. **公开 URL 可被任何人访问/篡改排片** → 无敏感数据；v1 加 `<meta robots=noindex>`；介意再加 PIN 门（决策 D3）

---

## 8. 开工前待拍板决策（默认值=推荐）

> ✅ **已拍板（2026-09-09）**：D1=Vite+TS 无框架｜D2=静态 JSON + D1 用户数据｜D3=无鉴权+noindex｜D4=LLM 兜底由 WorkBuddy 对话代跑

| # | 问题 | 推荐默认 | 备选 |
|---|---|---|---|
| D1 | 前端形态 | Vite + TS，无框架；网格自研 + FullCalendar free 日视图 | 纯手写零构建 / React |
| D2 | 排期数据放哪 | 静态 `schedule.json`（只读，版本化）+ D1 仅存用户数据 | 全量入 D1（可在线改期，复杂度↑） |
| D3 | 访问保护 | 无鉴权 + noindex（自用可接受） | 简单 PIN（functions 中间件，约半小时） |
| D4 | LLM 兜底/中文译名生成 | 在 WorkBuddy 对话里由我代跑（零配置、无 key） | 自备 OpenAI 兼容 API key（写进脚本） |

### 落地偏差记录（2026-09-09,搭骨架时）

1. **D1 行程视图**:v1 未引入 FullCalendar free,改用自研议程列表(按日分组、冲突红条、优先级/方案即时切换)。原因:FullCalendar 增 ~300KB 且样式难融自研网格;行程本质是"已选清单+冲突",列表比 day view 更清晰、移动端更友好。后续想要周/日时间轴视图再加不迟(不改变"网格自研"决策)。
2. **构建链**:PLAN §2 原设想 `public/` 直接当部署目录;实际为 Vite 项目,`public/` 是 vite 静态源(schedule.json/venues.json/robots.txt 被拷入 `dist/`),部署目录 = `dist/`,`functions/` 仍在项目根,`wrangler.toml.pages_build_output_dir = "./dist"`。
3. **豆瓣老开放 API 实测(2026-09-09)**:用户找到的 `goddlts.github.io/douban-api-docs` 为豆瓣**官方 v2 API 文档镜像**(api.douban.com/v2)。实测 `GET /v2/movie/subject/:id` → **HTTP 403**;`/v2/movie/search?q=` → **`invalid_apikey`(code 104)**。豆瓣开放平台早已停发新 key,该路径不可用 → 维持 D2 半自动方案(前端拼搜索链接 + 用户粘贴链接回填),海报富化继续走 `subject_suggest` 慢速模式。

## 9. 下一步

1. ~~拍板 §8 四个决策~~ ✅ 已确认（见上）
2. M0：脚手架 + 部署冒烟 — ✅ **2026-09-09 已搭**:wrangler.toml / 0001_init.sql(user_plan+douban_map) / functions(plan、mapping 动态路由) / Vite+TS 骨架 / mock schedule.json(3 天×5 厅 22 场,含 GV/重复场/跨馆重叠)
3. M2：用 mock 数据把核心排片与 .ics 全链路做通 — ✅ 前端网格选片/冲突红标/行程/导出 .ics 已实现并部署冒烟过;待真机验证
4. 待官方 PDF 发布 → M1 灌真数据 → M3 增强收尾(转场按场馆对、豆瓣映射批量回填、FullCalendar 可选)
5. UI 视觉对齐 BIFF 官方 —— 🚧 见 §10（调研完成,待改样式后真机看效果微调）

---

## 10. UI 视觉对齐 BIFF 官方（2026-09-09,晚）

> 目标:去掉「通用 SaaS 蓝」感,把工具外观对齐釜山电影节官网的**黑白编辑风 + BIFF 红点缀**。
> 调研源(两份参考站 + logo 资源,均已抓取实样):`biff.kr/eng`(英文首页)、`biff.kr/kor`(韩文首页,同设计系统)、`/kor/img/cmm/top_logo.svg`(官方字标)。Schedule 页为 JS 动态渲染,静态抓不到,视觉 token 以首页/公共 CSS 为准。

### 10.1 官网实样提取的设计 token(非猜测,来自线上 CSS/SVG)

| Token | 值 | 出处 |
|---|---|---|
| **BIFF 红(唯一品牌色)** | `#ce1e36` | 全站 accent:focus/hover/选中/标签/主按钮;渐变到 `#e32e2f` |
| 主按钮 | `linear-gradient(#ce1e36 → #e32e2f)` 白字 | `.btn.btn-primary` |
| 墨色(标题/强调) | `#111` | `h5_tit`/top_logo.svg 字标 100% `#111111` |
| 正文/次要 | `#333` / `#737373` | contents.css |
| 弱化灰 | `#888`/`#aaa` | — |
| 分隔线 | `#ddd` / `#e0e0e0` | — |
| 面板底 | `#f4f4f4`/`#f5f5f5`/`#fafafa`(页面白) | — |
| 小标题方标 | 10×10、圆角 3、**3px 红色描边**(不填充) | `.h5_tit::before` |
| 字体 | Pretendard(韩/拉丁默认)、IBM Plex Sans Condensed(排期数字感)、Cormorant SC(装饰衬线) | global/main.css |

> 结论:**页面几乎黑白,红只做「选中/交互/强调」**,输入框 focus、标签选中、radio 勾选、主按钮全走 `#ce1e36`;logo 是纯黑字标。

### 10.2 映射方案(旧 → 新)

| 语义 | 旧(蓝系) | 新(BIFF 风) |
|---|---|---|
| 页面底 `--bg` | `#f4f5f7` | `#f4f4f5`(官网面板灰) |
| 面板 | 白 | 白(不变) |
| 墨 `--ink` | `#1c2128` | `#111` |
| 弱化 `--muted` | `#6b7280` | `#737373` |
| 线 `--line` | `#e2e5ea` | `#e0e0e0`(soft/faint 相应拉灰) |
| 品牌 `--brand` | `#0f62fe` 蓝 | `#ce1e36` BIFF 红(全站:链接/日期选中/A-B 切换/导出主按钮/强调) |
| must / 冲突 | `#d43a2f` | `#ce1e36`(与品牌同色,靠描边/底色区分) |
| maybe | `#d97706` 琥珀 | 保留琥珀(语义色,不硬塞进黑白) |
| wild | `#64748b` | `#8a8f98` 中性灰 |
| GV | `#7c5cff` 紫 | `#111` 黑底白字小标签(黑白编辑风) |
| logo | 蓝底白字圆角块 | **纯黑字标**(官网 top_logo 同款 #111,去底),副标题前加红描边小方标 |
| panel h2 | 纯文字 | 前加 3px 红描边小方标(官网 h5_tit 同款) |
| 圆角 | 10/7 | 面板 8、卡片 5、按钮 6(官网偏直角) |
| 主按钮 | 纯蓝 | 红渐变 `#ce1e36→#e32e2f` |
| A/B seg、日期 chip 选中 | 蓝/黑填充 | 红填充白字(官网 radio 选中红同源) |

### 10.3 改动范围与验收

- 文件:仅 `src/style.css`(变量+组件微调);顶栏/标题结构不动;TS 零改动(已复核:无硬编码颜色)。
- 保留:must/maybe/wild 语义色差、冲突红标、同步绿点(状态色,不属品牌)。
- 验收:本地 build + 真机截图对比;用户逐项挑刺微调(按钮 hover、chip 圆角、冲突底色浓淡等)。
- 不引入:外部字体(中文 UI 用系统栈,数字用 tabular-nums),避免加 CDN 依赖/国内加载问题。

---

## 11. 影片库:全片浏览 + 搜索 + 反向定位(2026-09-09,晚二)

> 需求:「影院×时间轴」点场次能到豆瓣(已有 ⓘ→详情弹层,含同片场次+豆瓣搜索/直达),补全「看全部影片」入口与搜索反向定位。

| 项 | 实现 |
|---|---|
| 入口 | 顶栏新增「影片库」按钮(ghost),打开大号弹层 |
| 列表 | 按同片判定 key 聚合(中/英文名任一同即同片,与详情弹层一致),每部片=片名行+可展开的场次行;首行含 中文名/英文名/n 场/首场日期,当前方案已选计数红章 |
| 搜索 | 顶部搜索框,即时过滤;**code(前缀/包含)/中文名(title_zh 或豆瓣回填 title_cn)/英文名**;命中时自动展开,空词折叠;无结果给出提示 |
| 反向定位 | 点某场次行「定位 ▸」→ 关闭弹层 → 切到该场日期 → 页面滚到排片面板 → 网格横向滚到卡片居中 → 卡片**闪烁高亮 2 次**(红圈动画) |
| 到豆瓣 | 片名行「详情 ⓘ」→ 复用现有影片详情弹层(豆瓣直链/搜索/粘贴回填) |
| 代码 | 新 `src/library.ts`;main.ts 加 jumpToScreening;顺带修 modal keydown 监听泄漏(closeModal 走 dismiss 统一清理) |

- 验收:8 部 mock 全列出;搜「疯癫/Crazy/001」均命中;跨日期场次定位会切日期;build + typecheck 通过。

---

## 12. 影片目录接入 films.json(2026-09-09,晚三)

> 用户:把「所有影片」先接进来(海报/豆瓣后置)。源文件实为微信收到的 **xlsx**(`2026第31届釜山国际电影节影片信息.xlsx`,250 部),非 CSV。

| 项 | 实现 |
|---|---|
| 离线产出 | 新 `tools/build_films.py --xlsx → public/films.json`(一次性;保留脚本便于目录更新)。字段:id f001… / unit(单元清洗『』【】)/ remark / title_zh / title_orig / year / rating / rating_count / country / director |
| 前端接入 | `Catalog.films`;data.ts 容忍 films.json 缺失(旧部署 404 → 空目录) |
| 影片库合并 | 目录片为主索引(表序),排期场次按 **中文名 / 目录原始片名==排期英文名** 挂到目录节点;未命中排期片兜底自成一节点 |
| 目录态 | 无排期片:灰章「暂无排期」,展开显示占位说明;有排期片照旧可展开场次+定位 |
| 搜索 | 覆盖 中文名/原始片名/英文名/code/单元·国家·导演 |
| 结果 | 250 部全入库;mock 8 部排期片中文名 100% 命中目录(如 疯癫老人日记→f002) |
| 后续 | 官方 Catalogue 排期接入后同片自动带出;豆瓣海报富化走 enrich_douban.py 慢速(未接) |

## 13. 「AI 帮我排片」可行性评估与决策(用户征询,2026-09-09)

### 13.1 结论先行
- **可行,但最优形态不是"对话式 LLM",而是本地确定性求解引擎**。排片=硬约束优化(时间不重叠、转场缓冲、必看优先、GV 权重、每日容量),这类问题 LLM 会"看起来合理但算错冲突",且每次增删都要整段重算、不可解释。
- 现有体系已天然具备输入:**三等级 = must/maybe/wild(必看/备选/随缘)已在 PlanEntry;A/B 方案已存在**。缺的是"给片打标 → 引擎出建议 → 一键落盘"的闭环。

### 13.2 推荐 v1(零 key、零成本、可解释)
```
影片库打标(wish: 片 → must/maybe/wild,localStorage)
      ↓ 点「智能排片 ▸」
引擎(前端 TS):每片候选场次 = 该片已发布排期(shows)
    · must:尽量全覆盖(冲突时给"牺牲建议")
    · maybe:按权重贪心(GV/单元星级/评分)
    · 约束:同方案不重叠 + 跨影院转场缓冲(transitMin)
    · 每天场次/场馆均衡惩罚
      ↓
输出:Plan A 建议行程(评分/为什么放弃哪几场)+ 一键「采纳为 A 方案」
```
- 算法:must 强制 + 按启发式排序的贪心 + 有限回溯(候选同片 1~6 场,规模小,毫秒级)。
- 产出两版(A= 全 must+高分 maybe;B= A 的互斥备选,同片不重复)。

### 13.3 LLM 增强(缓做/可选,遵守 D4 不配 key)
- 真自然语言调优(「周三晚上别排海云台」)需要 LLM:要么用户自备 OpenAI 兼容 key 走 Functions(工作量大),要么 **WorkBuddy 代跑**(导出 wish+约束 JSON → 对话里我排 → 回贴 JSON 导入)。二者都不阻塞 v1。

### 13.4 里程碑
- **M2.5(AI 排片 v1,wish 打标 + 引擎 + 一键应用)**:catalogue 排期接入前用 mock 8 片即可联调演示 → 排入下一开发轮。
- ✅ **已于 2026-09-09 收官批整体落地**(完整记录见 §19):wish 打标(localStorage `biff.wish.v1`)+ `engine.ts` 本地求解引擎 + A/B 预览 modal + 一键采纳 `state.replaceGroup`(替换整组后逐条推云)。
- 依赖:wish 存储(localStorage 已做;D1 `user_wish` 表未新增——采纳后才产生 user_plan 数据,未采纳 wish 仅存本地,符合 v1 设计)、影片库行内三选控件(即 `.wish-seg`)。

## 14. UI/交互优化评审(用户建议逐条,2026-09-09)

> 原则:网格自研结论不变;**不引 FullCalendar(resourceTimeline 付费)/ Bryntum / dnd-kit / Framer**(无框架、只读点选为主,重组件体积/样式难融);地图类(Leaflet 免 key / Kakao·Naver 本地化)只做 M3 影院分布+haversine 估值,釜山现场前非必要。动画用 CSS transition/View Transition,足够。

| # | 用户建议 | 结论 | 状态(2026-09-09 收官批) | 实现方式/批次 |
|---|---|---|---|---|
| 1a | 转场间距可视(相邻<阈值画警示) | ✅ 采纳 P0 | ✅ 落地(§19.1) | grid.ts `markTightGaps()`:同日同方案相邻非冲突连场,余量 <`OK_SLACK`(15,与 16-D 共用)在上场卡右缘画 `.gap-bar`(tight 琥珀斜纹/bad 红) |
| 1b | 冲突卡强提醒+斜纹/呼吸灯+hover 联动 | ✅ 采纳 P0 | ✅ 落地(§19.1) | `.card.conf` 浅红斜纹(CSS 渐变)+ 2px 红边;hover 一卡 → 同冲突组全部 `.hl`(`conflictGroupFor()` 扩展) |
| 1c | 时间刻度垂直贯穿线增强 | ✅ 采纳 P0 | ✅ 落地(既有,本轮核对) | 背景小时线近墨 8%、半小时间线 4%,与标尺 tick 对齐贯穿 |
| 1d | 卡片字阶拉大;GV 高饱和紫底白字 | ✅ 采纳 P0 | ✅ 落地(§19.1;GV 改色被否) | code/时间/片名 12/12/13px;GV 徽章**维持墨黑底白字**(用户拍板,不紫底) |
| 2a | 行程清单 ↔ 甘特双向 hover 联动 | ✅ 采纳 P0 | ✅ 落地(§19.1) | 文档级 mouseover/out 委托 `.card[data-code]↔.a-row[data-code]`,re-render 不失效 |
| 2b | 转场提示组件化(两场之间插 Alert 节点) | ✅ 采纳 P0 | ✅ 落地(并入 §17 16-D) | agenda 相邻行三态 `gapNote`(ok/tight/bad +「需缓冲 Nmin」)已覆盖;独立 Alert 节点不新增 |
| 2c | A/B & 优先级切换分段控件+动画 | ✅ 采纳 P0(动画轻量) | ✅ 落地(§19.1) | 行内 `.pri-seg` 三键(必看/备选/随缘)→ `state.setPriority`;A/B 顶栏 seg 既有;CSS 过渡 |
| 3 | 组件库(FullCalendar/vis/map/dnd) | ⚠️ 不引入(结论见上) | — | 维持自研;文档 §2 决策已锁定 |
| 4a | 影院转场矩阵 Transit Matrix | ✅ P1(M3) | ⏳ 未做(随 M3) | venues.json 增 transit_min 邻接对 + 设置覆盖;UI 网格叠加 |
| 4b | 一键抢票顺位清单 | ✅ P1(小成本) | ✅ 提前落地(§19.1) | export 菜单加「抢票顺位清单(复制)」(`data-which="PICK"`)→ `copyPicklist()`:当前组按 must→maybe→wild→GV 优先→时间排序,header 含各档计数 |

- ✅ P0 可视化批次 + M2.5(AI 排片)+ 16-A + 4b 已于 2026-09-09 收官批一次性全部落地(记录 §19);4a 仍随 M3,3 不引入。

## §15. 官方 BIFF 品牌素材接入与使用许可

### 抓取的素材(`public/brand/`)
- `favicon.ico`(16×16, 1.1KB)— 直接抓自 biff.kr `/kor/img/favicon.ico`
- `biff-wordmark.svg`(原 306×36 BIFF + "BUSAN INTERNATIONAL FILM FESTIVAL" + 日期 "1-10 OCT 2025",111KB)— 顶部主标原版
- `biff-mark.svg`(由 wordmark 改 viewBox 0 0 96 36 裁出,仅保留 "BIFF" 三字)— 用于本工具顶栏,避免 wordmark 自带 "2025" 与项目年份冲突
- `ft_logo.png`(1077×249 RGBA,19KB)— biff.kr 页脚标原图

### 接入位置
- `<link rel="icon" href="/brand/favicon.ico">` — 浏览器 tab 图标
- 顶栏 `.logo-img` 改为 `<img src="/brand/biff-mark.svg">` — 替换原 "BIFF" 文本样式,纯黑 #111 与官方一致
- 底部 `<footer id="page-foot">` 加 `ft_logo.png` 与 "数据来自 biff.kr · 仅作个人非商用排片参考" 归属行
- 顶栏原有 "2026 排片" 副标与红方框标识(`.brand-sub::before`)保留不变

### 许可说明(给后续维护者的注意事项)
- biff.kr 公开页面未提供 logo/字标的显式下载授权条款,BIFF 是韩国 BIFF 组织委托/注册的商标,完整版权与商业使用权归官方与组委会所有
- 本项目用途明确:**个人非商业自用排片参考**,不收费、不再分发、不嵌入对外公开链接;仅做工程化排片辅助
- 底部显式声明"排片数据/场次信息来源于 biff.kr 公开页面",并附官网入口 — 属于合理使用范围的"出处署名"形式
- 截图/二次分享本应用时建议保留底部 footer 归属行,这是最低限度的礼节性归属
- **如未来改为商业/收费用途、或对外公开部署并被大量传播,需立即移除以下三件素材并替换为自有设计**:`favicon.ico`、`biff-mark.svg`、`ft_logo.png`(全删或仅保留 biff-wordmark.svg 作为"识别性引用")。
- 长期更稳妥的做法:页面顶部明确加 "Unofficial fan tool, not affiliated with Busan International Film Festival" 类声明;若官方日后提供 API/Brand kit,可换为正式授权资源。

### 15.1 2026 全字标升级(2026-09-09 晚)
- 用户提供渲染图(左侧章纹 + BIFF 大字 + "BUSAN INTERNATIONAL FILM FESTIVAL 31st" + "6–15 October 2026")存为 `public/brand/biff-2026-wordmark.png`(306×36 像素位图;许可沿用 §15 顶部"个人非商业自用"声明)。
- 顶栏 `<img class="logo-img" src="/brand/biff-2026-wordmark.png" alt="BIFF 2026 · 31st Busan International Film Festival · 6–15 October 2026">` 替换原 `biff-mark.svg`;CSS `.logo-img` 高度 38px(306:36 比例 → 宽约 323px),确保右侧全名/年份可读;≤720px 窄屏降为 26px(宽约 221px)避免独占整行。副标 `.brand-sub`(红方框 + "2026 排片")**已移除**(与全字标"6–15 October 2026"重复,index.html 与 style.css 同步删除,无残留引用)。
- 旧 `biff-mark.svg`(BIFF 三字裁切)/ `biff-wordmark.svg`(2025 全字标,带 "1-10 OCT 2025")保留在 brand/ 目录以备回退,顶栏已不再引用;footer `ft_logo.png` 与 `favicon.ico` 不变。

---

## 16. 参考站借鉴清单 — myhkifflist/HKIFF50(用户指路,2026-09-09 晚)

> 参考:https://chanfukl.github.io/myhkifflist/ (作者 chanfukl,单文件 SPA,无框架;数据内嵌;源码 GitHub chanfukl/myhkifflist)。结构与我们高度同源:场馆×时间轴网格 + 我的排片 + 全部影片目录 + 场地指南。**结论:亮点集中在「影片目录信息密度」与「转场/缓冲量化」两处,其余(网格/冲突/A-B/存储)我们更强或平手,不搬。**

### 16.1 亮点盘点与结论

| 参考站做法 | 我们现状 | 结论 |
|---|---|---|
| 卡片直接展示「豆 x.x」豆瓣评分 + ↗ 外链(db 字段存完整 subject URL) | films.json 250 部中 50 部已有 rating,但**前端没渲染** | ✅ 借鉴:评分徽章(有分才显示) |
| 影片目录顶部单元筛选按钮组(.ff/.fb)+ 单元色 legend | 影片库只有搜索框,无单元筛选 | ✅ 借鉴:单元筛选 chips |
| 我的排片页 transport-bar:公共交通/步行/驾车/buf **四模式 seg**;TR 场馆矩阵 + `gt(a,b)` 双向查表;buf 自动加档(≤10→+10 / ≤20→+12 / 否则 +15min) | PLAN §5.2/§14 4a 只有"transit_min 邻接对"雏形,无模式与档位 | ✅ 借鉴:模式化 TR + buffer 分档(落地转场提示) |
| 相邻场次插入间隔状态行 `.tw.ok/.tight/.bad` 三态 | §14 2b 只有 红条(紧)/灰字(宽裕) 两态 | ✅ 借鉴:升级三态判定 |
| 场次特性小徽章 sc-badge:sub 字幕/qa 映后/pre 首映 | 只有 GV tag | ⚠️ 可选:remark 特性 badge 体系 |
| 场地指南 tab:venue-card + 通勤矩阵公开表 .mx-table(色阶 self/fast/mid/slow) | 无公开矩阵面板 | ⚠️ P1:设置内「场馆距离」面板 |
| plan-cnt 导航小红点计场次数 | 顶栏已有 conflict-badge | ❌ 不做(无导航结构,避免噪音) |
| exportPlan=window.print() 打印成 PDF | 已有 .ics 导出 | ❌ 不做 |
| 附属活动联动 planAddWithChild(选片自动带同日大师班/讲座) | BIFF 无此体系(GV 是场次属性非独立活动) | ❌ 不搬 |
| 无任何 localStorage(纯内存,刷新丢) | 已有 D1 云同步 | ❌ 我们更强 |
| **无冲突检测**(仅同片同馆同日去重,时间重叠不查!) | conflict.ts 完整重叠检测 + A/B 隔离 | ❌ 我们更强 |

### 16.2 采纳项与批次(命名延续 16-A~F)

| # | 项 | 落地 | 批次 |
|---|---|---|---|
| **16-A** | 评分徽章「豆 x.x」 | 影片库行首 + 影片详情 modal 显示评分(豆绿色系?NO——BIFF 黑白红风,用墨色灰字 + 小方标即可);rating 为空不渲染 | ✅ 落地(§19 收官批) |
| **16-B** | 影片库单元筛选 chips | library 顶部搜索框下加一排 unit chips(全部 + 主要单元);点选过滤并计数;与搜索叠加 | P0 本轮 |
| **16-C** | 转场量化:模式 + buffer | venues.json/常量增加 TR 表(公交/步行/驾车三值 + 双向查表 `gt(a,b)`);agenda/grid 转场提示按当前模式 + buf 档计算「需 X min」 | P0 本轮(并入 §14 2b 一起做) |
| **16-D** | 转场间隔三态 | 相邻场次提示升级:bad=重叠或 <需求时差 / tight=刚好/紧 / ok=宽裕(阈值≥15min 余量) | P0 本轮(并入 2b) |
| **16-E** | 场馆距离矩阵公开面板 | 设置里加「场馆转场」表格(成对分钟 + 三档着色),数据同 16-C | P1(M3) |
| **16-F** | 场次特性 badge | remark/特性字段 → 小徽章(sub/qa/pre/GV);grid 卡与详情可复用 | P1 可选 |

- **数据噪声提示**:films.json unit 存在 `2026/2027/2028/2029年度亚洲电影人奖-杨紫琼专题` 四个近乎重复项(疑 xlsx 年份错乱),以及 `On Screen 单元3部·均为剧集首映` 长串名 → 16-B 筛选 chips 用 **prefix/包含匹配 + 归并**(如「广角镜」「Vision」「Korean Cinema Today」各合并一类),不精确等值;否则 chips 会碎成 25+。
- 单元色 legend 不搬(与 BIFF 黑白红风冲突;我们已有 优先级/冲突 语义色)。

### 16.3 验收(本轮 P0 四连 16-A~D)
- 16-A:有 rating 的卡片显示「豆 8.4」类徽章;无评分 不显示;详情 modal 同步
- 16-B:chips 点选过滤、计数正确,与搜索叠加、空态提示;mock 8 部可验证
- 16-C/D:agenda 相邻行显示「🚶 转场 Xmin 馆A→馆B」;bad/tight/ok 三态有区分;切模式/缓冲档后数值变化可感知
- `npm run build`(tsc + vite)通过;8135 预览手测

### 16.4 本轮执行范围(用户拍板,2026-09-09 深夜)
> 用户在 16-A~F 里只挑了三项:**16-B 单元筛选 chips + 16-D 转场间隔三态 + 16-F 场次特性 badge**。
> 16-A(评分徽章)/16-C(模式化 TR + buffer 分档)/16-E(场馆距离矩阵)均**不在本轮**;16-D 只做「三态提示」,
> 不引入交通模式与档位表 —— 缓冲仍用设置里现有单一 transitMin(默认 0,代表数据未齐),避免无中生有造场馆数据。

## 17. 16-B / 16-D / 16-F 落地记录(2026-09-09 深夜)

### 17.1 16-F 场次特性 badge 体系(先做地基,其余两项复用它)
- **类型**:`Screening` 增加可选 `tags?: string[]`;`is_gv: true` 等价隐含 `"gv"` 键(不迁移旧字段,官方数据导入时 tags 照填即可)。
- **注册表**:新增 `src/badges.ts`(`BADGE_DEFS` + `screeningBadgeKeys` / `badgeEl` / `appendBadges`)——新增特性只需加一行定义,**渲染点零改动**。
  已注册:`gv`(GV·映后对谈,悬停说明「时长已含 +25min」)/ `masterclass`(大师班)/ `premiere`(首映)/ `open_talk`(Open Talk)。
  未注册键静默忽略(向前兼容,不炸渲染)。
- **渲染接入 4 处**:grid 卡片 t1 / agenda 行标题 / 影片库 lib-row / 详情弹层 fm-row;原手写 `<i class="gv-tag">` 全部换 `appendBadges()`。
  - 细节:modal 的「· GV(含+25min)」文字移到 GV 徽章 hover title,时长文本不再内嵌。
- **配色**(延续黑白红语言):GV=墨黑实心(沿用 gv-tag);大师班=实心红(最高关注);首映=白底红描边;Open Talk=白底墨描边。
- **mock 数据**:7 场加了 tags(001/010 premiere、003/013/023 open_talk、006/020 masterclass),跨 3 天分布,用于肉眼验证徽章组合。
  `schedule.json` festival.note 已注明 tags 为演示用途。

### 17.2 16-B 影片库单元筛选 chips
- **归并规则** `unitKey()`(src/library.ts,导出可测):广角镜×3 / Vision×2 / Korean Cinema Today×2 / 亚洲电影人奖(2026~2029 四连脏数据)/
  CARTE BLANCHE / On Screen 前缀归并;其余保原文。25 个脏 unit → **18 组 + 全部**。
- **交互**:搜索框下一排 chips(墨黑激活,与日期条红激活区分);点选过滤 + 再次点击取消;与搜索关键词叠加(AND);
  纯排期片(无目录 unit)只在「全部」下出现;计数静态(目录片数),动态匹配数在 stat 行。
- chips 排序按片数降序:广角镜 47 / Icons 35 / World Cinema 29 / 亚洲电影之窗 28 / Vision 24 / 主竞赛 14 …

### 17.3 16-D 转场间隔三态(agenda 相邻行)
- 阈值:`slack = 间隔 gap − 跨馆缓冲 need`(同馆 need=0,跨馆 need=transitMin 设置值,默认 0=数据未齐)。
  **ok** slack≥15(默认灰)/ **tight** 0≤slack<15(琥珀 --maybe)/ **bad** slack<0(红 --conf,文案补「需缓冲 Nmin」)。
  重叠冲突仍走 conf 行态(红框+⚠),三态行不再重复标红。
- hover title 展示算式:`间隔 Xmin − 缓冲 Ymin = 余量 Zmin(宽裕/偏紧/不足)`。
- mock 可验证场景:003→004(10min 跨馆,默认即 tight);把「跨场馆转场缓冲」设 30 后同对变 bad。

### 17.4 偏差与待办
- 偏差:16.3 验收表里 16-C 的「🚶 模式 seg / buf 分档」本轮不做,三态只吃单一 transitMin —— 符合用户拍板范围。
- 已知视觉边界:grid 卡片窄时多徽章可能溢出裁剪(卡片 overflow hidden);等真实排期宽度数据出来后再决定是否按宽窄降级显示。
- 影片库 250 部无排期 → chips 筛选后仍大量「暂无排期」,符合现状(Catalogue 接入后自动有场次)。
- 验证:`npm run build`(tsc + vite)通过;8135 预览手测入口:
  ①影片库 → chips 点选 广角镜/Vision/亚洲电影人奖 等;②行程添加 003+004 看 tight,设置里把缓冲调到 30 再看 bad;
  ③grid/影片库/详情里看 GV、大师班、首映、Open Talk 徽章。

## 18. 飞书《2026 第 31 届釜山国际电影节指南》借鉴（用户指路,2026-09-09 傍晚→晚）

> 来源：https://svq9crvmohg.feishu.cn/wiki/U9RjwYCFXi4arXk21zIc9RPGnbd（《忠武路特派》9 月 3 日更新版,影迷攻略,非官方排片）。
> 定位：**正式排片仍以 9/11 17:00 KST 官方发布为准**；本篇只提炼攻略中的「日历骨架 / 分区 / 售票节奏」等确定性事实 —— 恰好补齐 mock 阶段缺的真实日期与场馆语义。浏览器抓取完整正文后逐节清洗（/tmp/s21、s32、s51_clean.txt），以下结论基于原文。

### 18.1 文档事实 × 项目现状对照

| 组 | 文档事实（原文口径） | 现状 | 结论 |
|---|---|---|---|
| 日期 | 电影节 **10/6(二)–10/15(四)** 共 10 天 | mock festival.dates 仅 10/8–10/10 三天 | ✅ 已对齐：dates 扩为真实 10 天窗口（§18.2） |
| 规模 | 正式入选 246 部/59 国 + Community BIFF = 315 部；常规+Community 共 **8 剧场 31 屏** | 无此口径 | ✅ 已写入 festival.note / venues.note |
| 排片公布 | **9/11（五）17:00 KST = 京 16:00**；「影片—日期—场馆—放映代码」最终组合届时才知 | 工具把 mock 当最终排期展示 | ⚠️ 记档：9/11 后 M1 灌真数据；届时再考虑加「正式排期已上线」提示（mock 期不加,避免噪音） |
| 售票 | 两轮：**9/17 14:00**（开闭幕 30k / Midnight Passion 20k / Actors' House 15k / Open Cinema·Community BIFF 10k）；**9/21 14:00**（一般放映 / Master Class / Cine Class）；每放映代码限 2 张 | 无购票信息 | ✅ 已写入 note；§14 4b 抢票顺位清单未来按此分层 |
| 退票 | 放映前 60min 截止；≥6 天免费；5–3 天 普 1k/开闭幕 3k；2 天–60min 普 3k/开闭幕 9k；购票当天取消免费 | 无 | ❌ 工具不管理退款,记档即可 |
| 分区 | **三区模型**：Centum 主场区（BCC / CGV Centum / LOTTE Centum / KOFIC / Sohyang / Community Media Center）｜南浦洞（BIFF Square / MEGABOX Busan Theater / Catholic Center Space 101.1）｜分散（BIFF Everywhere 10/3–15,17 处含机场/首尔） | venues.json 仅 bcc/cgv/lotte/mega 四组 mock | ✅ 已写入 venues.note（数据表结构不动,见 18.3） |
| 跨区 | **Centum↔南浦 ≥ 约 60min 门到门**；同区连场也别卡太紧（散场/下楼/过街/找厅/验票）；地铁 2 号线 Centum City 站 6 号口→BCC 步行约 9min；地铁约 05:00–23:59 各站不同 | 16-D transitMin 默认 0=数据未齐 | ⚠️ 不做 zone 兜底,理由见 18.3 |
| 特别活动 | Community BIFF 10/8–11（另有 10/5 19:00 Night Before）；Forum BIFF 10/8–11（产业）；闭幕 10/15 BCC Outdoor Stage（闭幕片=竞赛最高奖,赛后定）；Actors' House 10/7 李敏镐 / 10/8 金高银·金敏荷 / 10/9 柳承龙·朱智勋 / 10/10 申敏儿（新世界 Centum City 9F Culture Hall,15k,韩语） | 无 | ❌ 非排片类独立活动,不在 Catalogue 放映代码体系;等官方 Festival Events 总页,个人排片大概率不追 Forum/产业场 |
| 单元建议 | 世界首映/竞赛/Gala/只放一场更值得抢;同场区更好赶,南浦单独半天;「三列片单（必看/想看/可替代）」够用 | must/maybe/wild + A/B 已有 | ✅ **观念验证**：优先级体系与官方攻略一致,不需新功能 |
| GV | 2.2 抢票备忘里明确要记「是否带 GV」 | extract_schedule 已做 GV 识别,end_time+25min | ✅ **流程验证**：与 M1 管线设计一致 |
| Carte Blanche | 金知云选《Mad Max》/范冰冰《The Handmaiden》/洪庆彪《Three Colours: Blue》,三人到对应映后 | — | ❌ 嘉宾-影片-映后关联,等官方 Events 总页,记档 |

### 18.2 本轮落地（2026-09-09 晚,纯数据修正,零 TS 改动）

- `public/schedule.json`：`festival.dates` → 2026-10-06 ~ 10-15 十天真窗口（作未来日期条骨架,M1 前仅元数据）；`festival.note` 补排片公布时点/两轮售票与票价/246+69=315/8 馆 31 屏。
- `public/venues.json`：`note` 记录官方三区模型与 8 馆名单、Centum↔南浦 ≥60min、mega-haeundae 不在本届官方名单（保留供 mock 跨馆演示）。
- 不改 `festival.dates` 消费逻辑：UI 日期条由场次日期派生（data.ts `dates`），扩充后无空档日副作用；mock 场次仍 10/8–10/10（真窗口内）。

### 18.3 明确不做与理由（避免无中生有,守 §16.4 先例）

1. **venue.zone + 跨区 60min 兜底进 16-D**：mock 所有跨馆连场都发生在 Centum 集群内（bcc/cgv/lotte/mega-haeundae 相邻区），**无 Centum↔南浦跨区场次** → 做了无可演示差异；且 mega-haeundae 归属存疑（真实影院但非官方 8 馆）。等 M1 官方 venue 名单落地再定 zone 归属，届时跨区 pair 有真数据支撑。
2. **「9/11 排片发布」倒计时/提示条**：mock 期无数据管线支撑,纯装饰噪音;9/11 真排期上线时提示才有意义。
3. **购票/退款辅助 UI**：工具不做票务管理;两轮售票信息已入 note,抢票顺位清单(§14 4b)未来按票价分层做。

### 18.4 给 M1 真数据管线的注记（下轮 Catalogue 接入时生效）

- `festival.dates` 将作为日期条骨架：若希望空档日也显示（含开闭幕/Community 等非放映日）,需产品确认空日占位文案（如「该日暂无已发布场次」）。
- 官方排片含 放映代码 + 日期/场馆/厅 + 是否 GV + 单元 → 与 films.json unit 关联,「仅一场」稀缺提示可纯派生（场次数=1 的影片在详情/库内提示,对应攻略"只放一场更值得抢"）。
- 8 馆名单核对：mock venues 里 mega-haeundae 届时删除,南浦 3 地点按需补入(Community BIFF 场次用)。

---

## 19. P0 可视化批次 + M2.5 AI 排片 + 16-A 落地记录（2026-09-09 收官批）

> 范围拍板（本轮对话）：「全部含 M2.5 一次做完」= P0 可视化批次（§14 1a/1b/1c/1d/2a/2c）+ 整条 M2.5（AI 排片引擎）+ 16-A 评分徽章 + §14 4b 抢票顺位清单（P1 小成本项顺手提前）。
> GV 徽章**维持墨黑底白字现状**（用户拍板,推翻 §14 1d 原记的紫底改色）。2b 不新增组件化 Alert 节点——上轮 §17 16-D 的三态 `gapNote` 已覆盖该语义。
> 验证状态：**tsc strict 全绿 + vite build 通过（dist 已更新）；引擎 mock 冒烟通过；浏览器真机交互待手测（清单 §19.3）**。

### 19.1 交付清单

| 项 | 文件 | 说明 |
|---|---|---|
| 全局转场余量阈值 | util.ts `OK_SLACK = 15` | 1a / 16-D 共用一个常量 |
| 1a 网格转场紧凑警示 | grid.ts `markTightGaps()` + style `.gap-bar` | 同日同方案相邻非冲突连场,余量 <15min 在上场卡右缘画条（tight 琥珀斜纹 / bad 红）,阈值与 agenda 16-D 一致;冲突对不双画（conf 红框已表达） |
| 1b 冲突斜纹 + hover 整组 | style `.card.conf` + conflict.ts `conflictGroupFor()` + grid/main `.hl` | 网格 hover 一卡 → 所在冲突组全体加 `.hl`（自身 + 对侧成员,经冲突组集合扩展） |
| 1c 时间刻度线 | （既有,本轮核对） | 小时线/半小时间线贯穿背景,与标尺 tick 对齐 |
| 1d 字阶定案 + GV 墨黑 | style `.card` t1/b/ttl/sub | code/时间/片名 12/12/13px;GV 徽章维持墨黑底白字 |
| 2a 双向 hover 联动 | main.ts 文档级 mouseover/out 委托（`.card[data-code]↔.a-row[data-code]`）+ `.hl` | 视图 re-render 后仍生效;与 1b 共用同套高亮机制 |
| 2c 优先级分段控件 | agenda.ts `.pri-seg` + state.ts `setPriority(code, pri)`（删 cyclePriority）+ main.ts `data-act="pri"` 分支 | 行内三键 必看/备选/随缘 替代循环 chip,CSS 过渡 |
| 4b 抢票顺位清单 | main.ts `copyPicklist()` + index.html export 菜单 `data-which="PICK"` | 仅当前 group,按 must→maybe→wild→GV 优先→时间排序生成文本行（header 含各档计数）,clipboard 复制 + toast |
| 16-A 评分徽章 | library.ts / modal.ts `.rating-chip` | 影片库目录行 + 影片详情 modal 展示「豆 x.x」灰字小徽章,rating 为空不渲染 |
| M2.5 wish 打标 | state.ts `LS_WISH="biff.wish.v1"` + `wish` Map + `loadWish()/setWish(key, pri\|null)`;library.ts `.wish-seg` 三键（再点取消,悬停解释） | 影片库每片行头三个 wish 档按钮 |
| M2.5 引擎 | engine.ts `suggestPlans(EngineInput): EnginePlan[]`（纯函数） | 见 §19.2 |
| M2.5 预览 + 采纳 | library.ts `openEngine()/enginePlanBox()/adoptPlan()` + style `.eng-*`;state.ts `replaceGroup(g, picks)` | 「智能排片 ▸」→ A/B 方案卡 + 未纳入原因列表 + 采纳按钮;采纳=删组内旧项/改 pri/补新项 → 本地落盘 + 逐条推云 → 切组并 disabled「✓ 已采纳」 |

### 19.2 M2.5 引擎行为（mock 冒烟已验）

- 输入 = wish 打标片列表（每片全部已发布场次）;约束与前端同源：`blocks(a,b,transitMin)` 同日期 + 跨馆缓冲。
- **must**：DFS 前缀剪枝收集全部可行解（场次数最多 → 总 end 最早）,取两个去重解为 A/B;冲突时给「牺牲」说明而非硬塞（unscheduled + 原因：被占用/暂无排期/未命中）。
- **maybe**：按权重（评分×2 + 有 GV +1）贪心填空档;**wild** 不进自动单。
- 冒烟场景 1（transit=0,4 片打标）：A 两 must 全入 + 高分 maybe;B 在备选 slot 上产生合理差异。
- 冒烟场景 2（transit=30,跨馆仅 20min 余量）：两套方案都正确牺牲其一 must,drop 解释「候选时段与已排重叠:…」;牺牲在 A/B 间反向,可解释性正确。

### 19.3 待真机手测（代码已过 tsc+build,浏览器交互未亲测）

1. 网格 hover 卡片 → 自身 + 同冲突组 + agenda 对应行高亮;反向 agenda hover → 网格卡高亮（1b/2a）。
2. 紧邻两场（003+004,跨馆 10min）→ 网格 gap-bar 出现;设置里把转场缓冲调 ≥15 → 条消失（1a 与 settings 联动）。
3. 行程行内 必看/备选/随缘 三键即时切换（2c）;GV/首映/大师班/Open Talk 徽章不回归（16-F 回归）。
4. export 菜单「抢票顺位清单(复制)」→ 粘贴核对文本与档位计数（4b）。
5. 影片库给 2~4 片打 wish（行头三键）→「智能排片 ▸」→ A/B 预览 → 采纳 → 行程被整组替换、状态上云、按钮 disabled（M2.5 全链路）。
6. 影片库行首/详情 modal 的「豆 x.x」灰字徽章仅在有评分时出现（16-A）。

### 19.4 备注

- agenda 16-D 三态 `gapNote`（§17 落地）本轮保留不动;1a 只在 grid 侧新增物理警示条,两者阈值同源、位置不重复。
- D1 `user_wish` 表未新增：未采纳的 wish 仅存 localStorage,采纳后才经 `replaceGroup` 产生 user_plan 云数据,符合 v1「云只存最终行程」设计。

---

## 20. 样式体系重构 + 外部优化建议审核 PLAN — Tailwind v4 + Design Token，基准 Linear/Vercel/Notion/Apple Calendar（合并终版,2026-09-09 晚）

> 背景：用户转来两条外部建议长文，要求逐条审核后**重新构造下一轮 PLAN**；用户明确指示「样式用 Tailwind CSS（最适合本项目）+ Linear/Vercel/Notion/Apple Calendar 设计语言」须体现在 PLAN 中。
> 建议一（样式体系）：Tailwind + CSS Variables Design Token + Lucide + 自研 Badge/冲突/AB 样式，不引组件库。
> 建议二（架构/时间轴）：vis-timeline 做时间轴引擎 + 类型化 Conflict Engine + Transit Matrix + 转场线可视化 + MapLibre + 方案评分器 + core/algorithm/timeline 目录重构。
> 审核方法：逐条对照**当前代码事实**（非凭印象），结论 = ✅采纳 / ⚠️部分采纳 / ❌不采纳 + 依据。
> **合并说明**：本 §20 出现过两个版本（另一窗口前序稿 + 本稿,标题撞车），已合并为单一终版——① Tailwind 裁决按用户意图改为「✅ 有条件采纳 = v4 增量接入,不整仓原子类化」（前序稿误判为 ❌,其三条反对理由恰被 v4 增量方案逐条回应,见 20.2 1-2）;② 代码基线按实测修正（前序稿称 style.css「0 变量」,实测已有 18 变量,见 20.1）;③ 设计语言基准（Linear/Vercel/Notion/Apple Calendar）补齐为 20.2 1-6 + 20.4 落地。

### 20.1 代码事实基线（审核依据,2026-09-09 实测）

- `src/style.css`（594 行）：`:root` **已有 18 个变量**（--bg/--panel/--ink/--muted/--line/--brand/--must/--maybe/--wild/--gv/--conf/--radius/--shadow/--font 等,§10 BIFF 视觉对齐时建）,但组件区仍散落 **~16 种裸 hex、合计 60+ 处**（#fff×39 反白文字、#fdecec/#f3c3c7/#fdf0f1/#fef3f4 红系浅底、#f5c16a 琥珀浅、#2f9e44 状态绿、#adb5bd/#c9c9c9/#9a9a9a/#e2e2e2 灰阶）→ 建议一的 Token 化收编增量**真实存在**;且现有变量是"用途名"（--bg/--panel/--must）而非"层级名",本轮升级为分层 Design Token + 收编散落值（§20.4 P0-1）。
- `src/conflict.ts`：`computeConflicts(slots, transitFor)` — `transitFor(a,b)` **已是注入函数**,pair 无类型细分（二元 code 对）。→ Transit Matrix 只需在数据层提供查表,核心算法零改动。
- `src/engine.ts`：M2.5 已产出 A/B + `stats{must,mustIn,maybe,maybeIn,wild}` + drop 原因,**但无方案评分**。→ 评分器 = 纯增量。
- UI 符号：emoji/字符图标全站仅 ~10 处且已统一（⚠ 冲突×5、ⓘ 详情×3、▸ 按钮×2、✓ 采纳×1）→ 引 Lucide 库净负担。
- 网格为**官方固定排期展示 + 点选**：场次时间不可拖、不可 resize;卡片已深度定制（优先级色边/conf 斜纹/gap-bar/徽章/双向 hover 冲突组联动/A-B 隔离重算）。

### 20.2 建议一逐条审核（样式体系）

| # | 外部建议 | 结论 | 依据（对照代码事实） |
|---|---|---|---|
| 1-1 | 不引组件库,业务组件自研 | ✅ 认同（无动作） | 与 PLAN §2/§14 既定决策一致;badges.ts、conf 斜纹、A/B seg 已自研落地 |
| 1-2 | Tailwind 做基础样式 | ✅ 有条件采纳 → P1-4（用户点名要 Tailwind） | 裁决 = **Tailwind v4 CSS-first 增量接入,不整仓原子类化**。逐条回应原三条反对：① "全量迁移=推倒" → 不迁移,存量 594 行语义 CSS 保留;② "别全写成 Tailwind 类" → 双轨制:存量语义类、新 UI 用 utility;③ "新增构建链" → v4 无 tailwind.config.js(纯 CSS `@theme`),Vite 走 `@tailwindcss/postcss` 单插件,且只 `@import theme + utilities` 不引 preflight。收益 = token 编译器 + 新 UI 的 utility 源。详见 §20.4 P1-4 |
| 1-3 | CSS Variables 建 Design Token | ✅ 采纳 → 本轮 P0-1 | **硬事实（实测）**:`:root` 已有 18 个"用途名"变量,但组件区仍散落 ~16 种裸 hex 共 60+ 处（详见 20.1）。升级为分层 Design Token + 全量收编,视觉零变化、可维护性立涨 |
| 1-4 | Lucide Icons | ❌ 引库 / ⚠️ P2 内联 SVG | 全站符号仅 ~10 处且语义已统一;无框架下 lucide 需 createIcons 初始化。若要统一：自建 5 个内联 SVG（⚠/✓/×/▸/ⓘ）零依赖,见 P2-8 |
| 1-5 | 时间轴/冲突/A-B 全自研 | ✅ 认同（无动作） | grid 1.25px/min 绝对定位、conf 斜纹、gap-bar、A-B seg 均已在自研体系内 |
| 1-6 | 视觉基准 Linear/Vercel/Notion/Apple Calendar（用户明示要体现） | ✅ 采纳为**设计基准** → P0-1 + P2-9 | 现 UI（BIFF 黑白编辑风+红点缀）已接近"低装饰/高信息密度/小圆角/克制阴影",本轮是**收口统一非推翻**：灰白底 #f4f4f5、白卡 #fff、细边 #e0e0e0、text 三阶 #111/#525252/#737373、品牌红 #ce1e36 唯一点缀、琥珀警告 #d97706、绿仅状态点 #2f9e44、时间数字 tabular-nums（Apple Calendar,已做）。色值一律以**官网抓取为准**（外部稿 #d71920 不采） |

### 20.3 建议二逐条审核（架构/时间轴）

| # | 外部建议 | 结论 | 依据 |
|---|---|---|---|
| 2-1 | vis-timeline 做时间轴引擎 | ❌ 不采纳 | ① **排期=官方固定时间,不可拖/resize**——vis 核心卖点 editable/drag 是伪需求;② 卡片深度定制（conf 斜纹/gap-bar/徽章/冲突组 hover 联动/A-B 重算）迁入 vis item DOM 全部重接,且其 stack/overlap 策略与"重叠即冲突、用斜纹表达"的现哲学冲突;③ 规模：一人 5~15 场/天、全站数百场,自研 O(n²)+手写 scroll 足够;④ 未来要"缩放"只需把 1.25px/min 变量化。与 §14 不引 FullCalendar(资源视图付费)/Bryntum 同列 |
| 2-2 | 类型化 Conflict Engine（SAME_VENUE/TIME_OVERLAP/TRANSIT_TIGHT/IMPOSSIBLE + severity） | ⚠️ 部分采纳 → P2 | 判定逻辑 blocks()+transitFor 已齐,UI 已有 slack 三态（agenda gapNote ok/tight/bad）;缺的是"类型细分后的精确文案"（如同厅重叠 vs 跨馆重叠）。收益仅文案级 → 轻量补 label,不为枚举重构 |
| 2-3 | Transit Matrix（场馆对查表） | ✅ 采纳 → P1 | conflict.ts `transitFor(a,b)` 已是注入函数、engine.blocks 按馆对判 → **数据层加 pair 查表即可,两处核心算法零改动**;对应 §14 4a + 16-C/E。mock 期 4 馆可先填步行估值演示,fallback 单一值保留 |
| 2-4 | 转场线可视化（卡片间连线+分钟标签） | ⚠️ 部分已落地 | agenda 三态 gapNote + grid gap-bar 已覆盖"同场馆相邻"语义;grid **跨行连线视觉噪音大**（不同场馆行物理距离远）,不做 |
| 2-5 | MapLibre 地图 | ❌ 不采纳（维持 §14 原判） | 4 个场馆放 marker 用 WebGL 地图=过度工程;若 M3 要影院分布,Leaflet（免 key）或 haversine 距离列表足够;釜山现场前不做 |
| 2-6 | 方案评分器 Plan Scoring | ✅ 采纳 → 本轮 P0-2 | engine 已产出 A/B + stats + drop,缺"可比较分数"。加纯函数 `planScore()`（场次命中权重+GV 奖励−紧张转场 penalty−总移动惩罚）→ 0-100,A/B 预览卡与顶栏方案标签展示。**把 M2.5 从"能出解"升为"能比较解",是两条建议里唯一点中核心竞争力的项** |
| 2-7 | core/algorithm/timeline 目录重构 | ❌ 不采纳 | 规模不匹配：16 modules / gz 15.4KB;现有扁平文件已按职责分离（data/conflict/engine/state + 视图渲染层）;纯搬文件零行为收益 + 制造噪音。折中：未来新文件遵循 domain 前缀命名 |
| 2-8 | interval-tree-1d（大规模区间查询） | ❌ 不采纳（现在） | n≤20 时 O(n²)=400 次比较;真到全站几百场/日在 M1 后再评估,建议文本身也说不必现在上 |

### 20.4 重构后的下一轮迭代计划

**P0（纯增量、零架构改动、不动现有视觉,本轮即可做）**

1. **P0-1 Design Token 化**（采纳 1-3 + 1-6）:style.css `:root` 在既有 18 变量上**分层升级**（旧名保留为 alias 指向新名,TS 零改动）——brand `--biff-red:#ce1e36`/`--biff-red-hover:#b9151b`/soft `#fdecec`/line `#f3c3c7`;surface 三级 `--bg-page:#f4f4f5`/`--bg-card:#fff`/`--bg-subtle:#fafafa`;border 三级 `--border-default:#e0e0e0`/`--border-strong:#c9c9c9`/`--border-faint:#f4f4f4`;text 四阶 `--text-primary:#111`/`--text-secondary:#525252`/`--text-muted:#737373`/`--text-faint:#a3a3a3` + `--text-on-brand:#fff`;status `--status-danger:var(--biff-red)`/`--status-warning:#d97706`/`--status-ok:#2f9e44`/`--status-wild:#8a8f98`;radius 6/8/12 + pill;shadow card/hover 两档;字阶 `--text-2xs~md`（11/12/13/14px,Notion 式克制阶梯）。再全量替换组件区 ~16 种散落裸 hex（#fff→text-on-brand、红系浅底→soft/line、#f5c16a→`color-mix(in srgb,var(--status-warning) 15%,#fff)`、浅灰→bg-subtle/border-faint、绿点→status-ok）。验收：替换前后视觉 diff 为零（截图/肉眼核对 4 大视图）+ **裸 hex 硬断言**（`:root` 外仅允许 #fff 与 SVG 遮罩白）,build 通过。
2. **P0-2 方案评分器**（采纳 2-6）:engine.ts 导出 `planScore(plan): {score, parts}`——命中场次按档加权（must×3/maybe×2/wild×1）、GV 场 +5、硬冲突 -∞（引擎产出恒 0）、紧张转场（同方案相邻跨馆 gap<15）各 -5、场馆切换次数 -1；归一 0-100。展示：engine modal A/B 卡标题行加「评分 N」+ parts 摘要;顶栏 A/B seg 当前方案旁加评分徽章（可选,若轻量）。验收：A/B 双卡分数差异与直觉一致（must 多/GV 多/转场少 → 分高）。
3. 收尾:两条 P0 后跑 `npm run build` + 8135 本地预览核视觉。

**P1（原定 M1 官方排期落地后、2026-09-11 起；其中 P1-4 Tailwind 与 M1 无依赖,可随时提前单独做）**

4. **P1-4 Tailwind v4 接入**（采纳 1-2,增量双轨）:`npm i -D tailwindcss @tailwindcss/postcss`;vite.config.ts 挂 postcss 插件;style.css 顶部 `@import "tailwindcss/theme";` + `@import "tailwindcss/utilities";`（**不引 preflight**,保留自研 reset）;`@theme { --color-biff:#ce1e36; --color-ink-2:#525252; --radius-card:8px; … }` 与 :root token 同源（token 是唯一色源）;用法约定 = 存量组件语义类（内部读 var）、**新写 UI 用 utility + 小组件类**（引擎卡/设置面板/后续弹层）。验收：现有 UI 零可见变化、build 通过、dist gz 增量记录（基线 js 15.4 / css 4.4 gz）,纯 CSS 可回滚。
5. **P1-5 Transit Matrix**（采纳 2-3）:venues.json 增 `transit_min` 邻接对（8 馆真名单步行估值,同区小/跨区大,Centum↔南浦 ≥60 依 §18）;data.ts 提供 `transitFor(venueA,venueB)` 查表（未配对 fallback settings.transitMin 单一值）;conflict.ts/engine.ts **零改动**（接口已注入）;设置面板加「场馆转场」可编辑表格（16-E,成对分钟 + 三档着色）。
6. M1 真数据管线（既有 §3/§5 计划）:官方 Catalogue PDF → extract_schedule.py → schedule.json 真数据（放映代码/日期/场馆/GV/单元）+ venue 名单核对（删 mega-haeundae,补南浦）。

**P2（可选增强,不阻塞）**

7. 冲突类型细分文案（采纳 2-2 轻量版）:conflict pair 增加 `kind: "same-venue"|"cross-venue-overlap"|"transit"` 供展示文案区分。
8. 图标统一（采纳 1-4 折中）:自建 5 个内联 SVG 常量（alert/check/x/chevron/info）替换 ⚠/✓/×/▸/ⓘ 符号,零依赖;不做也成立。
9. 视觉 5 件套微统一（采纳 1-6 收口,P0-1 token 基础上）:Badge 尺寸/圆角/字重 token 化（16-F 已建 BADGE_DEFS）;Button/Seg/chips 的 hover/active/disabled 三态（hover 用 `--biff-red-hover`、shadow 用 `--shadow-hover`）;gap-bar 与 conf 斜纹色值读 status token;字阶收敛到 `--text-*` 命名。纯 CSS、逐屏像素级核对。

**明确不做（记录驳回与理由,防止未来反复评估）**

10. **整仓 Tailwind 原子类化 / 推倒重排**（1-2 的"全量"形态;增量版已采纳,P1-4）/ 11. vis-timeline·FullCalendar·DayPilot（2-1）/ 12. MapLibre·地图组件（2-5）/ 13. 目录结构大重构（2-7）/ 14. interval-tree-1d（2-8）/ 15. Lucide 库（1-4,自建内联 SVG 已够）——理由见上表,均与"排期固定不可编辑 + 自研深度定制 + 规模不需要 + 零重依赖"四原则冲突。

### 20.5 与本轮（§19 收官批）的关系

- §19 已交付的 M2.5 引擎正是评分器的天然输入;P0-2 不新建求解路径,只加"比较层"。
- P0-1 Token 化与 §10 BIFF 视觉对齐一脉相承：§10 当时是"把蓝换红"的语义改色,现在是"把色值收进变量"的结构收拢,视觉规范不变。
- 下一轮执行入口：**P0-1（Design Token 收编,Linear/Notion 灰阶与字阶基准随 P0-1 落地）+ P0-2（方案评分器）一次做完** → build + 预览核视觉（前后 diff 零）→ 之后 P1-4 Tailwind v4（随时可做,不依赖 M1）→ 9/11 M1 后接 P1-5 Transit Matrix 与真数据。
- ⚠️ 待用户拍板：① P0-1+P0-2 是否本轮一次做完?② Tailwind v4（P1-4）是提前单独做,还是等 P1 批?③ P2-8 内联 SVG / P2-9 视觉 5 件套是否顺手带上?
