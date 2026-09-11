# BIFF 排片工具(BIFF Scheduler)— 项目活文档

> 定位:自用釜山电影节排片工具 —— 解析官方 Ticket Catalogue → 可视化选片排期 → 冲突检测 → 导出 .ics → 一键跳豆瓣。
> 栈:Cloudflare Pages(**纯静态**)+ Vite + TS(无框架)+ Tailwind v4(增量双轨)+ 静态 JSON。
> **本文档 = 当前状态 + 决策 + 待办 + 架构(活文档)。历史轮次记录已归档至 `docs/history/`,不要再往回写流水账。**
> 最后更新:2026-09-09 晚(PLAN 瘦身重构)。

---

## 0. 当前状态快照(2026-09-09)

**✅ 已完成(已部署,线上可访问)**
- 脚手架:Vite+TS 无框架;部署目录 `dist/`(wrangler `pages_build_output_dir = "./dist"`);**纯静态**(functions + D1 已于 2026-09-11 退役)
- 核心排片:自研 CSS Grid 网格(影院×时间)、点选加入行程、同方案冲突红标、A/B 双方案隔离
- 行程视图:自研议程列表(按日分组、优先级/方案即时切换)—— 不用 FullCalendar(见 §2 决策)
- 导出:`.ics`(UTC、GV 场次时长已含 +25min);抢票顺位清单复制
- 影片库:films.json 250 部目录接入,搜索(中/英/code/导演/单元)+ 单元筛选 chips + 反向定位(跳转并滚动闪烁)
- 豆瓣:静态映射(`public/douban.json`,离线产物)+ 中英文搜索兜底;不做爬虫
- M2.5 智能排片:影片库 wish 打标(must/maybe/wild)→ **AI 排片**(自填 API Key、浏览器直连服务商、返回本地复检)→ 预览采纳
  - 2026-09-10 变更:原本地确定性求解 + `planScore()` A/B 方案卡**已整体下线**(PLAN-20260910143516);
    `engine.ts` 已更名 **`score.ts`**(PLAN-20260910232833),现仅保留**行程质量分** `scorePlanRows()`(服务「我的行程」头部 `分 N` 药丸)
- 视觉:BIFF 黑白红风对齐(官方抓取 #ce1e36)+ Design Token 化(:root 分层 token)+ Tailwind v4 增量接入
- 品牌素材接入(brand/):wordmark/favicon/footer,含许可约束(见 §8)
- 排片表字段徽章 + 图例总览:`legend.ts` 单源 — 等级(ALL/12/15/19)、字幕/对白标识(KE/KN/KK/NO/未标注)、节目册页码、片长 全部以小徽章流渲染(网格卡 / 行程 / 影片库 / 详情),每枚 data-tip 即时说明;场馆行显示官方代码 chip + 整行 hover 全名/韩名/分区/代码 说明;顶部「ⓘ 日程表说明」点击打开总览弹层(字段速读示例 / 等级 / 字幕 / 徽章 / 影院代码本工具行 + 2025 官方代码总表 references / 网格图例 / P&I·开闭幕·GV·节目册 特别提示)
- 网格卡选中态改"底色交互":`in-plan` / `hl-card` 移除左侧 3px 优先级竖条 + 优先级色外晕,改用整卡 `color-mix(--pc 14%, card)` 淡底色染色(must/maybe/wild → 红/琥珀/灰);与紧转场整卡底色同一交互语言
- **存储与适配(2026-09-10,PLAN-20260910235630 / PLAN-20260910235000)**:
  **片单(选片 / 排片)只存 localStorage**、云端 `user_pick` 整体退役(见 §2 D5)—— 清空后刷新 / 部署不再复活;
  设置里新增「清空全部(选片 + 排片)」;
  暗色**跟随系统**、窄屏 ≤768px **列表优先**、字阶/圆角**值命名 token** 生效、按钮类名收敛到 `ui.ts`
- **零后端(2026-09-11,PLAN-20260911001107)**:D1 整体退役 —— 豆瓣映射改静态 `public/douban.json`
  (`/api/mapping*`、`functions/`、`migrations/`、`wrangler.toml` 的 D1 绑定、`migrate:remote` 全部删除);
  弹层豆瓣区只读(条目直链 / 中英文搜索兜底);顶栏 `#sync-dot` 与 `renderSync()` 删除
- **工程化(2026-09-11,PLAN-20260911000705)**:接入 **PWA**(预缓存产物 + 只读 JSON → 现场断网可用;
  方形 PNG 图标 192/512 + iOS 180);**Vitest 单测 53 条**(24+ 时制 / GV 有效结束 / 冲突 / AI 本地复检)并接入 `build` 门禁;
  抽屉列表行加 `content-visibility: auto`(渲染优化,非完整虚拟化);
  `ui.ts::extraCls` 确立为**布局 / 变体专用**契约(试过 tailwind-merge,成本 gzip +9.7KB 换 0 调用点,已撤,见 §7.8)
- **全量审查后的优化轮(2026-09-11,PLAN-20260911004000)**:补完 D1 退役的删除步骤(`src/api.ts` / `functions/` / `migrations/` /
  `wrangler.toml` D1 绑定 / `migrate:remote` 全删,产物内 `/api/` = 0 次);
  状态层上 `groupIndex` + `slotIndex` 原地重建 + `mutate()` 批量出口 + 微任务合并广播(批量改动不再 O(n²) 写盘 / 重渲染);
  `codesOfGroup()` O(1);新增 `Catalog.filmByZh/filmByOrig` 影片索引(消除 O(screenings × films) 线性扫描);
  **`.ics` 正确性修复**:RFC5545 转义(`\` `;` `,` 换行)+ 按 **UTF-8 字节**折叠 + VALARM DESCRIPTION 补折叠;
  **弹层可访问性**:`role=dialog` / focus trap / 焦点归还 / body 滚动锁 / `aria-live` toast;
  **触屏与键盘可达的 tooltip**(旧版触屏永远看不到 `data-tip`);AI 错误区分**离线**、上限按模型上下文档位、补 `max_tokens`;
  跨文件重复的转场余量判定收敛为 `util.ts::slackBetween()` 纯函数;**单测 53 → 63**(新增 `tests/ics.test.ts`)
- **渲染层重构(2026-09-11,PLAN-20260911004000 §3.1)**:网格改为「**几何签名不变 → 就地 patch**」——
  `gridGeometryKey()`(内容签名,含起止 / 片长 / GV 时长)+ `patchGridStates()`(含「先清上一轮内联紧张底色」这条关键不变量);
  卡片状态抽成纯函数 `cardStateOf()`(构建 / patch 共用,node 可单测);徽章行按场次**模板 clone**;
  **订阅分域** `ChangeDomain`(theme 域跳过网格与抽屉重绘);`notify` 加**订阅方隔离**(单个抛错不再让其余静默不刷新);
  单测 **63 → 78**(新增 `tests/grid-state.test.ts`)。浏览器实测见该 PLAN §3.2

**⏳ 待办(按序,详见 §7)**
1. 9/11 官方排期发布后 M1:真数据管线 + venue 名单核对(删 mock 的 mega-haeundae,补南浦)
2. 真机手测残留清单(网格 hover 联动、gap-bar、wish→采纳全链路等,见 §7.3)
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
   `agenda.ts::gapConnector`(赶场间隔「⚠ 赶不上」)、`score.ts`(紧转场 −1 计数)、`ai.ts::buildPayload`(送给模型)。
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

```
离线管线(本机,非部署):Catalogue PDF → tools/extract_schedule.py → schedule.json / venues.json / films.json / douban.json(检入仓库)
在线应用(Cloudflare Pages,**纯静态**):
  dist/(Vite 产物)
  ├ schedule.json(只读排期)
  ├ venues.json(只读场馆)
  ├ films.json(只读目录)
  ├ douban.json(豆瓣映射,离线产物,可为空)
  └ assets/(main.ts 打包)

浏览器 localStorage(用户数据主存储,**不上云**):
  biff.picks.v2(选片+排片,唯一数据源) / biff.settings.v1 / biff.gvtalk*.v1 / biff.ai*.v1
```

**前端模块(src/,28 文件 + `style.css`)**:`main.ts` 装配+统一事件委托｜`state.ts` 全局 store + localStorage 持久化(**片单只存本地**)+ subscribe 订阅｜`grid.ts` 排片网格｜`agenda.ts` 行程列表｜`library.ts` 影片库+我的选片(抽屉)｜`ai-panel.ts` 智能排片弹层 UI｜`ai.ts` AI 打包/调用/复检(纯逻辑)｜`ai-prompt.ts` 隐藏主 Prompt｜`settings.ts` 设置弹层｜`picklist.ts` 抢票清单｜`modal.ts` 弹层栈｜`row.ts` 场次行骨架｜`conflict.ts` 纯函数冲突检测｜`score.ts` 行程质量分｜`ics.ts` 导出｜`gv.ts` 映后口径｜`badges.ts`/`legend.ts` 徽章与图例｜`pick.ts` 档位语义｜`ui.ts` 按钮/tab/缩放控件类名与工厂｜`chips.ts`/`form.ts`/`toast.ts` 共享 UI 片段｜`data.ts` JSON 加载(含豆瓣映射)｜`tip.ts` 悬停提示｜`types.ts`/`util.ts`/`style.css`

> 2026-09-10 结构收口(PLAN-20260910232833):`library.ts` 1784→928、`main.ts` 1137→786;
> AI 面板 / 设置 / 抢票清单 / 质量分 / Prompt 各自独立成文件;片名链 / 档位权重 / chip 类名 / 日期切段 / 时间标签收口到单一来源;补 `eslint` 门禁。
>
> 2026-09-10 适配与样式收敛(PLAN-20260910235000):**暗色跟随系统**(只覆盖 token)、
> **窄屏 ≤768px 列表优先**(默认开抽屉、网格降级为次级入口、顶栏按钮文案随主次切换)、
> **字阶/圆角值命名阶梯真正生效**(全站 `text-[Npx]`/`rounded-[Npx]` 归零)、
> 按钮/tab/缩放控件类名收敛到 `ui.ts`、品牌红拆出 `text-biff-ink`(暗色下提亮,实底不变)。

---

## 2. 已拍板决策(勿反复;论证记录见归档)

| # | 决策 | 结论 |
|---|---|---|
| D1 | 前端形态 | Vite+TS 无框架;网格自研;FullCalendar 只用免费的都嫌重 → 行程=自研列表(**v1 偏差:未引 FullCalendar**,增 ~300KB 且样式难融) |
| D2 | 排期数据 | 静态 JSON(只读、版本化);**D1 已于 2026-09-11 整体退役** —— 全站零后端(PLAN-20260911001107) |
| D5 | 片单存储 | **只存 localStorage**(2026-09-10,PLAN-20260910235630):曾双写 D1 `user_pick`,但旧的 `syncFromCloud` 是云端为准 + 每次部署换 origin → 已清掉的片单被同步回来、离线删除被覆盖;故云端片单整体退役(`/api/pick*` 删除) |
| D6 | 豆瓣映射 | **只读静态 `public/douban.json`**(2026-09-11,PLAN-20260911001107):D1 `douban_map` + `/api/mapping*` + 页面粘贴回填全部退役;留空即走中英文搜索兜底 |
| D3 | 访问保护 | 无鉴权 + `noindex`;介意再加 PIN 门 |
| D4 | LLM 兜底/中文译名 | 在 WorkBuddy 对话代跑(零配置),不自备 API key |
| — | 外部组件库 | 全不引(§20 审核后维持):vis-timeline/FullCalendar/MapLibre/Lucide/组件库均否决,理由:排期固定不可拖 + 自研已深度定制 + 规模不需要 + 零重依赖 |
| — | Tailwind | ✅ 有条件采纳 = **v4 增量双轨**(2026-09-09 已接入):不引 preflight;存量语义类读 token、新 UI 用 utility;token 是唯一色源 |

**代码事实基线(改前必知)**:`conflict.ts` 的 `transitFor(a,b)` 已是注入函数 → Transit Matrix 只需数据层加查表,核心算法零改动。

---

## 3. 数据契约

**静态 JSON(无数据库)** —— D1 已于 2026-09-11 整体退役(PLAN-20260911001107):
```json
public/douban.json = { "mappings": { "<code 或 f###>": { subject_id, title_cn, douban_url } } }
```

**localStorage(片单唯一源)**:`biff.picks.v2` = `PickEntry[]`(`{key, priority, picks:[{code,group}], note}`);
另:`biff.settings.v1` / `biff.gvtalk.v1` / `biff.gvtalkmin.v1` / `biff.ai.v1` / `biff.ai.dates.v1`。
旧 key `biff.plan.v1` / `biff.wish.v1` 仅作一次性迁移源,**迁移后即删**(否则 v2 缺失时旧数据会复活)。

**schedule.json Screening**:`code / title_en / title_kr / title_zh / date / start_time / end_time / duration_min / venue_id / venue_display / is_gv / tags?`
- **GV/映后:解析阶段就 end_time = start + duration(+25min)**(保证 .ics 与冲突检测一致,前端不临时补)
- `tags?`:gv/masterclass/premiere/open_talk(见 badges.ts 注册表;未注册键静默忽略)

**venues.json**:`id / name / display`;note 记录官方三区模型(Centum 主场区 / 南浦洞 / 分散)· 8 剧场 31 屏;Centum↔南浦 ≥60min 门到门
**films.json**:250 部目录(unit 需按前缀归并:广角镜×3/Vision×2/Korean Cinema Today×2/亚洲电影人奖 2026~2029 四连脏数据 → 18 组)

---

## 4. API

**没有 API**(2026-09-11,PLAN-20260911001107):选片 / 排片只落 localStorage,豆瓣映射是静态文件。
`functions/` 目录已删除;`/api/pick*`(2026-09-10)与 `/api/mapping*`(2026-09-11)均已退役。
旧的 `/api/plan*`(场次级,0003 退役)与 `/api/pick*`(影片级)均已删除。

---

## 5. 核心逻辑约定(易错点,改前必读)

- **冲突只针对同一方案内部;A/B 互不干扰**。选片 i 实际时段 = [start_i, end_i](end 已含 GV)
- 允许明知冲突强加,但始终视觉标红;`OK_SLACK = 15`(util.ts)为转场余量阈值,agenda 三态(gapNote ok/tight/bad)与 grid gap-bar 共用
- **.ics 一律导出 UTC(Z)**,提醒用相对 TRIGGER(`-PT45M` 可改);UID = `<code>@biff-2026`
- **存储分工(2026-09-11)**:片单(选片 / 排片)= **只存 localStorage**,`commit()` 落盘即完成、**没有云端回写**;
  豆瓣映射 = 静态 `public/douban.json`(`loadMappings()` 在首渲前灌好);设置 / GV 覆写 / AI 配置 = 本地。
  → 清空片单后刷新 / 重新部署**不会复活**(旧版会从 `user_pick` 同步回来)。**全站零后端。**
- localStorage keys:`biff.picks.v2`(片单唯一源)/ `biff.settings.v1` / `biff.gvtalk.v1` / `biff.gvtalkmin.v1` /
  `biff.ai.v1` / `biff.ai.dates.v1`;`biff.plan.v1` / `biff.wish.v1` 是**一次性迁移源,迁移后即删**
- `douban.json` 缺失 / 为空 = 零映射:弹层与影片库走中英文搜索兜底(不是错误态)

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
- 豆瓣映射富化 `enrich_douban.py`(慢速,**已接**:产物填 `public/douban.json` 的 `mappings`;海报不做)

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
3. D1 已退役(2026-09-11):~~`d1 execute --command` 只跑第一条 SQL~~ / ~~本地调试别传 `--d1`~~ 两条作废
4. 豆瓣爬虫必撞 CAPTCHA → 只做链接跳转(离线 `enrich_douban.py` 慢速回填 + 中英文搜索兜底)
5. **GV 时长在解析阶段 +25min,别在前端临时补**(保证 .ics 与冲突一致)

---

## 10. 文档地图

| 文件 | 用途 |
|---|---|
| `PLAN.md`(本文件) | 当前状态/决策/待办/架构 —— **每轮开发先读这里,完成后更新 §0/§6/§7** |
| `docs/history/2026-09-09-开发落地记录.md` | §10~§20 全部历史轮次(视觉对齐/影片库/AI 排片/样式重构等)+ plans 执行蓝本附录;只读查询,不再追加 |
| `data/` `tools/` | 离线管线脚本与产物(本地,不部署) |

> 维护纪律:新轮次的"落地记录"要么并入本文档对应章节、要么追加到 `docs/history/` 按日期建新文件 —— 不要在本文档堆砌一次性流水账。
