# BIFF Scheduler

釜山国际电影节选片与排期工具。用 React Router 和 React Spectrum S2 构建，数据保存在浏览器本机，可导出日历、分享图片与备份。

桌面上，影片库、我的选片和我的行程位于左侧，右侧保留可操作的排片表。手机使用按开场时间排列的纵向时间线。顶栏的「回到旧版」打开 `/legacy/`，保留原版完整界面；旧版顶栏可返回新版。

## 本地运行

需要 Node.js 22.12+ 与 npm。

```sh
npm ci
npm run dev
```

开发服务默认使用 `http://localhost:31026`。如果主工作区正在使用这个端口，可在独立 worktree 中运行：

```sh
npm run dev -- --port 31027
```

## 使用

在影片库搜索片名、导演、嘉宾、活动形式、单元或场次编号，将影片加入我的选片，再选择要参加的场次。我的选片支持备注和日期多选。影片库只读查看场次，排场在我的选片和时间轴进行。影片详情包含海报、豆瓣评分、简介、相关电影和嘉宾信息。

排片表可按字幕、影厅和 GV 筛选。影片库与排片表使用两套独立筛选，都会记住上次选择。影厅支持包含与排除模式，以及按影院和区域选择。桌面时间轴支持缩放、拖动平移、整点筛选和场次定位。

已选场次显示为绿色，转场余量不足显示为黄色，时间重叠显示为红色。重叠场次可以同时保留作为抢票备选。在我的行程中拖动调整顺位，或使用上移、下移按钮。保存当前方案时，每个冲突组只取第一顺位，再加上共同场次。第一顺位撞片时需要先选择让哪一组改选，也可以预览自动修复，再保存独立方案。

GV 场次可单独调整映后时长和是否参加。冲突、有效结束时间和日历导出使用同一套规则。所有页面显示韩国时间；ICS 日历使用 UTC，导入后按设备所在时区显示。

导出与分享从已保存方案生成 ICS、纯文本和 PNG。数据备份会包含所有 `biff.*` 数据；导入前会展示预览。JSON 备份整体替换本机数据，ICS 可以合并或替换已排场次。购票信息提供韩国时间、北京时间、票价和开票提醒日历。

## 路由

| 路径 | 内容 |
| --- | --- |
| `/legacy/` | 独立原版入口，同域共享原 localStorage；`/legacy` 自动跳转 |
| `/schedule` | 排片表，手机显示纵向时间线 |
| `/library` | 影片库 |
| `/picks` | 我的选片 |
| `/agenda` | 我的行程、顺位与已保存方案 |
| `/<view>/films/:filmKey` | 当前视图中的影片详情 |

日期、搜索、单元和定位目标保存在 URL 查询参数中；两个选片视图的展开状态在当前面板会话中保留。详情支持直接打开、刷新和浏览器后退。

## localStorage 兼容性

原有存储键、影片标识、场次编号、JSON 结构和备份格式保持兼容。新版使用原有状态模块读写，React 通过 `useSyncExternalStore` 订阅变更。读取 v2 数据不会自动重写；未知的 `biff.*` 键和设置扩展字段会保留。

`biff.plan.v1` 和 `biff.wish.v1` 仍按原版规则迁移。空的 v2 片单优先于旧版数据，清空后不会复活。具体结构和迁移规则见 [迁移说明](docs/react-spectrum-migration.md)，逐项修复与测试见 [旧版行为补齐](docs/parity-restoration.md) 和 [Review修复与旧版入口](docs/review-fixes-and-legacy.md)。

localStorage 按 origin 隔离。原站使用同一域名上线时会直接读取原数据；不同端口、域名或设备需要用备份搬移。

## 验证

```sh
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium webkit
npm run test:e2e
```

`npm run build` 包含 TypeScript、ESLint、全部单元测试和生产构建。`npm run test:e2e` 先构建，再通过独立端口 `31029` 的 `vite preview` 测试生产产物，不复用 dev 服务。E2E 使用独立浏览器上下文和合成旧版数据，不读取真实用户的浏览器资料。

测试配置包括桌面 Chromium、手机 Chromium 和手机 WebKit。离线 PWA、桌面拖动排序与跨视图高亮另有专项测试。HTML 报告位于 `playwright-report/index.html`；失败时保留截图和 trace。

## 实现

- React 19、React Router 8、React Spectrum S2。
- Vite 构建，React Spectrum 官方宏插件与语言裁剪插件。
- 原有冲突、GV、顺位方案、ICS、分享和备份逻辑继续使用纯 TypeScript 模块。
- 新版界面使用 React；`legacy/` 单独保留旧版 DOM 界面与 Tailwind 样式，两份样式互不加载。
- 静态数据从 `public/` 读取，生产环境使用 Cloudflare Workers 静态资源。
- PWA 预缓存应用与目录数据，可离线恢复已选影片与行程。

```text
legacy/           8a95215 原版快照和独立 HTML 入口
src/app/          应用外壳、状态订阅、目录投影、界面 hooks
src/components/   Spectrum 控件组合、场次卡、设置与导出弹窗
src/pages/        影片库、行程、甘特图、时间线与影片详情
src/state.ts      兼容原版的本机状态与持久化
src/*.ts          冲突、GV、方案、筛选、导出等领域逻辑
e2e/              浏览器测试与旧版存储实现快照
tests/            领域逻辑单元测试
public/           排期、影片、影院、海报与品牌资源
tools/            原有数据采集与生成工具
```

## 部署

```sh
npm run deploy
```

沿用 `wrangler.toml` 的静态资源配置与 SPA fallback，深层路由会回到应用入口。也可沿用仓库现有的 Cloudflare Workers Builds 流程。重写工作在独立分支进行，不会自动部署。

## 数据从哪来（部署时不需要解析 PDF）

**一句话**：部署链路与解析脚本无关。运行时数据就是仓库里的静态 JSON，它们**已经检入 git**，`npm run build` 时被 Vite 原样拷进 `dist/`，前端 `data.ts` 用 `fetch("schedule.json")` 加载。

| 文件 | 内容 | 由谁产出 |
|---|---|---|
| `public/schedule.json` | 全部场次（时间 / 影院 / GV / 分级 / 字幕 / 片长…） | **`tools/scrape_biff_web.py`（抓 biff.kr 官网排期页，2026 起的口径）** |
| `public/venues.json` | 影厅清单（厅 id / 影院 / 分区 / 官方代码） | 同上 |
| `public/films.json` | 影片目录（片名 / 单元 / 年份 / 国家 / 导演 / 豆瓣分） | `tools/build_films.py`（官方影片信息 **xlsx**） |
| `public/douban.json` | 豆瓣映射（**场次 code 与影片 `f###` 双键** → subject_id / 中文名 / 条目链接；**可为空**） | **`tools/build_douban_map.py`**（豆瓣官方 API，检索 `search/suggestion` + 详情 `movie/{id}` 确认） |
| `public/douban-related.json` | 豆瓣相关电影（subject_id → `/recommendations` 精简列表；**可为空**） | **`tools/build_douban_related.py`**（对已映射 subject 拉 Frodo 推荐；「是否本届」前端对照 mappings 现查） |
| `public/douban-intros.json` | 豆瓣简介（subject_id → intro；**可为空**） | **`tools/build_douban_intros.py`**（对已映射 subject 拉 `movie/{id}` 的 intro） |
| `public/festival-extras.json` | 官网「排期之外」的辅助信息：**开票批次 / 票价 / 购票须知**（Booking Information）、**节目嘉宾**（Master Class / Actors' House / Cine Class / Special Talk）、**开闭幕式红毯时间表 + 交通管制** | **`tools/scrape_biff_extras.py`**（抓 biff.kr 官网 `page_num=11402` / `11218` / `11219` / `11366` / `11226` / `11223` / `11233`；只保留 `schedule.json` 里真实存在的 code，自动滤掉往届遗留条目） |

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
python tools/build_films.py --xlsx <影片信息.xlsx> --out public/films.json \
    --enriched data/enriched_douban.json --posters-dir public/posters

# 海报下载（豆瓣图床有 Referer 防盗链,外链必 418 → 必须离线抓下来随站点部署）
python tools/fetch_posters.py --enriched data/enriched_douban.json --out-dir public/posters

# 官网抓取（现役口径）
python tools/scrape_biff_web.py --out-dir /tmp/biff2026 --films-json public/films.json
cp /tmp/biff2026/{schedule.json,venues.json} public/

# 豆瓣映射（官方 API；只写「片名命中 + 年份不矛盾」的高置信条目，其余留空走搜索兜底）
python tools/build_douban_map.py --films public/films.json --out public/douban.json --delay 3

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
   · 影片库侧 `public/films.json` 246 部里 **244 部**有中文名（余下 `PARADISE LOST` /
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

# 2) 收尾：泳道按「分区 → 影院 → 厅号」重排 + festival 元信息 → public/
python tools/import_schedule_2025.py \
    --schedule /tmp/schedule.json --venues /tmp/venues.json --dest public

# 3) 影片目录（二选一）
python tools/build_films.py --xlsx <影片信息.xlsx> --out public/films.json        # 有官方 xlsx 时优先
python tools/extract_films_2025.py --pdf <Catalogue.pdf> --out public/films.json  # 否则抽 PDF 介绍页

# 4)（可选）豆瓣映射慢速回填（产物填进 public/douban.json 的 mappings）
python tools/enrich_douban.py --xlsx <影片信息.xlsx> --out data/enriched_douban.json          # 有 xlsx
python tools/enrich_douban.py --films-json public/films.json --out data/enriched_douban.json  # 只有 PDF 产物
```

### 不想跑 Python 也行

`public/*.json` 就是普通 JSON，按 `src/types.ts` 里的契约手改或自己造即可 —— `data.ts` 还会做兜底归一（跨午夜时间补 24h、韩文片名兜底等），旧版 JSON 也能自愈。

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
- `public/brand/` 下的 BIFF 官方 logo 素材（favicon / 字标 / ft_logo）版权归 BIFF 组委会所有，**如转为商业或公开大规模用途，需移除并替换为自有设计**。
- 影片目录源为电影节官方影片信息表；豆瓣评分来自该表的评分列，豆瓣条目链接由 `tools/enrich_douban.py` 离线慢速回填，缺失即走搜索跳转。
- 本站不使用 Cookie 追踪、不做用户画像，**也没有任何后端**。**片单（选片 / 排片）只存于你自己的浏览器 `localStorage`**；豆瓣映射是构建期静态文件 `public/douban.json`，同样不采集任何用户数据。

**Unofficial fan tool, not affiliated with Busan International Film Festival.**
