# BIFF 排片工具(BIFF Scheduler)— 项目活文档

> 定位:自用釜山电影节排片工具 —— 解析官方 Ticket Catalogue → 可视化选片排期 → 冲突检测 → 导出 .ics → 一键跳豆瓣。
> 栈:Cloudflare Pages + D1(SQLite)+ Vite + TS(无框架)+ Tailwind v4(增量双轨)+ 静态 JSON。
> **本文档 = 当前状态 + 决策 + 待办 + 架构(活文档)。历史轮次记录已归档至 `docs/history/`,不要再往回写流水账。**
> 最后更新:2026-09-09 晚(PLAN 瘦身重构)。

---

## 0. 当前状态快照(2026-09-09)

**✅ 已完成(已部署,线上可访问)**
- 脚手架:Vite+TS 无框架;部署目录 `dist/`(wrangler `pages_build_output_dir = "./dist"`);functions + D1 已通
- 核心排片:自研 CSS Grid 网格(影院×时间)、点选加入行程、同方案冲突红标、A/B 双方案隔离
- 行程视图:自研议程列表(按日分组、优先级/方案即时切换)—— 不用 FullCalendar(见 §2 决策)
- 导出:`.ics`(UTC、GV 场次时长已含 +25min);抢票顺位清单复制
- 影片库:films.json 250 部目录接入,搜索(中/英/code/导演/单元)+ 单元筛选 chips + 反向定位(跳转并滚动闪烁)
- 豆瓣:半自动(前端拼搜索链接 + 粘贴回填映射到 D1),不做爬虫
- M2.5 AI 排片:影片库 wish 打标(must/maybe/wild)→ `engine.ts` 本地求解(A/B 方案 + 牺牲原因)→ 预览采纳
- 方案评分器 `planScore()`(engine.ts,0-100,A/B 卡展示)
- 视觉:BIFF 黑白红风对齐(官方抓取 #ce1e36)+ Design Token 化(:root 分层 token)+ Tailwind v4 增量接入
- 品牌素材接入(brand/):wordmark/favicon/footer,含许可约束(见 §8)
- 排片表字段徽章 + 图例总览:`legend.ts` 单源 — 等级(ALL/12/15/19)、字幕/对白标识(KE/KN/KK/NO/未标注)、节目册页码、片长 全部以小徽章流渲染(网格卡 / 行程 / 影片库 / 详情),每枚 data-tip 即时说明;场馆行显示官方代码 chip + 整行 hover 全名/韩名/分区/代码 说明;顶部「ⓘ 日程表说明」点击打开总览弹层(字段速读示例 / 等级 / 字幕 / 徽章 / 影院代码本工具行 + 2025 官方代码总表 references / 网格图例 / P&I·开闭幕·GV·节目册 特别提示)
- 网格卡选中态改"底色交互":`in-plan` / `hl-card` 移除左侧 3px 优先级竖条 + 优先级色外晕,改用整卡 `color-mix(--pc 14%, card)` 淡底色染色(must/maybe/wild → 红/琥珀/灰);与紧转场整卡底色同一交互语言

**⏳ 待办(按序,详见 §7)**
1. 9/11 官方排期发布后 M1:真数据管线 + venue 名单核对(删 mock 的 mega-haeundae,补南浦)
2. 真机手测残留清单(网格 hover 联动、gap-bar、wish→采纳全链路等,见 §7.3)
3. P1-5 Transit Matrix / P2-7 冲突文案细分 / P2-8 内联 SVG / P2-9 视觉收口(均未做)

---

## 1. 架构总览

```
离线管线(本机,非部署):Catalogue PDF → tools/extract_schedule.py → schedule.json / venues.json / films.json(检入仓库)
在线应用(Cloudflare Pages + Functions + D1):
  dist/(Vite 产物)              functions/api/          D1 biff-scheduler-db
  ├ schedule.json(只读排期)      ├ plan.js               ├ user_plan(我的排片)
  ├ venues.json(只读场馆)        ├ plan/[code].js        └ douban_map(豆瓣映射)
  ├ films.json(只读目录)         ├ mapping.js
  └ assets/(main.ts 打包)        └ mapping/[code].js
```

**前端模块(src/,16 文件)**:`main.ts` 装配+统一事件委托(上帝文件,暂不拆)｜`state.ts` 全局 store + localStorage/D1 双向同步 + subscribe 订阅｜`grid.ts` 排片网格｜`agenda.ts` 行程列表｜`library.ts` 影片库+AI 排片入口｜`modal.ts` 弹层｜`conflict.ts` 纯函数冲突检测｜`engine.ts` AI 排片引擎(纯函数)+ `planScore`｜`ics.ts` 导出｜`badges.ts` 场次特性徽章｜`data.ts` JSON 加载｜`api.ts` D1 API 客户端｜`tip.ts` 悬停提示｜`types.ts`/`util.ts`/`style.css`

---

## 2. 已拍板决策(勿反复;论证记录见归档)

| # | 决策 | 结论 |
|---|---|---|
| D1 | 前端形态 | Vite+TS 无框架;网格自研;FullCalendar 只用免费的都嫌重 → 行程=自研列表(**v1 偏差:未引 FullCalendar**,增 ~300KB 且样式难融) |
| D2 | 排期数据 | 静态 JSON(只读、版本化)+ D1 仅存用户数据;全量入 D1 = 复杂度↑ 不做 |
| D3 | 访问保护 | 无鉴权 + `noindex`;介意再加 PIN 门 |
| D4 | LLM 兜底/中文译名 | 在 WorkBuddy 对话代跑(零配置),不自备 API key |
| — | 外部组件库 | 全不引(§20 审核后维持):vis-timeline/FullCalendar/MapLibre/Lucide/组件库均否决,理由:排期固定不可拖 + 自研已深度定制 + 规模不需要 + 零重依赖 |
| — | Tailwind | ✅ 有条件采纳 = **v4 增量双轨**(2026-09-09 已接入):不引 preflight;存量语义类读 token、新 UI 用 utility;token 是唯一色源 |

**代码事实基线(改前必知)**:`conflict.ts` 的 `transitFor(a,b)` 已是注入函数 → Transit Matrix 只需数据层加查表,核心算法零改动。

---

## 3. 数据契约

**D1(migrations/0001_init.sql)**
```sql
user_plan(user_id TEXT DEFAULT 'me', code TEXT, group_tag TEXT DEFAULT 'A',  -- 'A'|'B'
          priority TEXT DEFAULT 'maybe',  -- must|maybe|wild
          note TEXT DEFAULT '', created_at/updated_at, PRIMARY KEY(user_id, code))
douban_map(code TEXT PK, subject_id INTEGER, title_cn TEXT, douban_url TEXT, updated_at)
```

**schedule.json Screening**:`code / title_en / title_kr / title_zh / date / start_time / end_time / duration_min / venue_id / venue_display / is_gv / tags?`
- **GV/映后:解析阶段就 end_time = start + duration(+25min)**(保证 .ics 与冲突检测一致,前端不临时补)
- `tags?`:gv/masterclass/premiere/open_talk(见 badges.ts 注册表;未注册键静默忽略)

**venues.json**:`id / name / display`;note 记录官方三区模型(Centum 主场区 / 南浦洞 / 分散)· 8 剧场 31 屏;Centum↔南浦 ≥60min 门到门
**films.json**:250 部目录(unit 需按前缀归并:广角镜×3/Vision×2/Korean Cinema Today×2/亚洲电影人奖 2026~2029 四连脏数据 → 18 组)

---

## 4. API(全部走 D1,`functions/api/`)

```
GET    /api/plan            → 我的全部排片
PUT    /api/plan/:code      → upsert {group_tag, priority, note}
DELETE /api/plan/:code
GET    /api/mapping/:code   → 豆瓣映射
PUT    /api/mapping/:code   → {douban_url|subject_id}(正则抽 /subject/(\d+)/)
```

---

## 5. 核心逻辑约定(易错点,改前必读)

- **冲突只针对同一方案内部;A/B 互不干扰**。选片 i 实际时段 = [start_i, end_i](end 已含 GV)
- 允许明知冲突强加,但始终视觉标红;`OK_SLACK = 15`(util.ts)为转场余量阈值,agenda 三态(gapNote ok/tight/bad)与 grid gap-bar 共用
- **.ics 一律导出 UTC(Z)**,提醒用相对 TRIGGER(`-PT45M` 可改);UID = `<code>@biff-2026`;DESCRIPTION 带豆瓣链接
- localStorage keys:`biff.plan.v1` / `biff.settings.v1` / `biff.wish.v1`(wish 仅本地,采纳后才产生 user_plan 云数据)
- 本地优先 + D1 尽力同步,API 不可用自动降级本地

---

## 6. 里程碑状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 脚手架+部署 | ✅ |
| M1 | 真数据管线(PDF→JSON) | ⏳ 等 9/11 官方 Catalogue PDF |
| M2 | 核心排片+导出 | ✅(mock 全链路;待真机验证) |
| M2.5 | AI 排片 v1(wish+引擎+采纳) | ✅ |
| M3 | 增强:Transit Matrix/豆瓣批量回填 | ⏳ 部分(M3 剩余见 §7) |

---

## 7. 待办清单(按优先级)

**7.1 M1 真数据管线(9/11 17:00 KST 排期发布后启动)**
- `tools/extract_schedule.py`:pdfplumber → Camelot(兜底)→ LLM 视觉残差页兜底;venue 别名归一;时间一律 KST
- venue 名单核对:删 mock 的 mega-haeundae(非官方 8 馆),补南浦 3 地点;8 馆 31 屏为准
- `validate_schedule.py` schema+冲突自检;`festival.dates` 已是真实 10/6–10/15 窗口(作日期条骨架,空档日占位待定)
- films.json 同片挂接:目录原始片名==排期英文名 / 中文名命中

**7.2 M3 剩余**
- Transit Matrix(P1-5):venues.json 增 `transit_min` 邻接对 + `data.ts transitFor(a,b)` 查表(未配对 fallback settings.transitMin);设置面板可编辑表格 —— conflict/engine 零改动
- 豆瓣海报富化 `enrich_douban.py`(慢速,未接);title_zh 批量候选

**7.3 真机手测残留(§19.3,代码已过 tsc+build)**
1. 网格 hover → 同冲突组 + agenda 联动高亮(反向亦然)
2. 紧邻跨馆场(003+004)→ gap-bar;设置缓冲 ≥15 后消失
3. 行程行内 必看/备选/随缘 三键即时切换
4. export「抢票顺位清单(复制)」内容核对
5. wish 打标 2~4 片 → 智能排片 → A/B 预览 → 采纳全链路
6. 「豆 x.x」徽章仅在有评分时出现

**7.4 P2 可选(不阻塞)**
- P2-7 冲突文案细分(kind: same-venue/cross-venue-overlap/transit)
- P2-8 自建 5 个内联 SVG(alert/check/x/chevron/info)替换 ⚠✓×▸ⓘ
- P2-9 视觉 5 件套微统一(Badge/Button/seg 三态、gap-bar/conf 读 status token、字阶收敛 --text-*)

---

## 8. 品牌素材与许可(重要,勿忘)

- `public/brand/`:favicon.ico / biff-mark.svg / biff-wordmark.svg / biff-2026-wordmark.png(顶栏在用)/ ft_logo.png(footer 在用)
- **个人非商业自用**前提;footer 保留"数据来自 biff.kr · 个人非商用"归属行
- **如转商业/对外大规模传播:立即移除 favicon.ico、biff-mark.svg、ft_logo.png 三件并换自有设计**

---

## 9. 风险与避坑(仍生效)

1. FullCalendar Resource 视图付费 → 网格已自研,别回退
2. 首次 `pages deploy` 卡非交互 → 先 `pages project create`(wrangler 已配好,勿删)
3. `d1 execute --command` 只跑第一条 SQL → 迁移用 `d1 migrations apply --remote`
4. 本地调试别传 `--d1`(另起 sqlite 实例 → no such table)
5. 豆瓣爬虫必撞 CAPTCHA → 只做链接跳转+粘贴回填
6. **GV 时长在解析阶段 +25min,别在前端临时补**(保证 .ics 与冲突一致)

---

## 10. 文档地图

| 文件 | 用途 |
|---|---|
| `PLAN.md`(本文件) | 当前状态/决策/待办/架构 —— **每轮开发先读这里,完成后更新 §0/§6/§7** |
| `docs/history/2026-09-09-开发落地记录.md` | §10~§20 全部历史轮次(视觉对齐/影片库/AI 排片/样式重构等)+ plans 执行蓝本附录;只读查询,不再追加 |
| `data/` `tools/` | 离线管线脚本与产物(本地,不部署) |

> 维护纪律:新轮次的"落地记录"要么并入本文档对应章节、要么追加到 `docs/history/` 按日期建新文件 —— 不要在本文档堆砌一次性流水账。
