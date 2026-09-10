# BIFF Scheduler · 釜山电影节排片工具

个人自用的[釜山国际电影节](https://www.biff.kr/)排片工具：把官方排期表变成一张可点选的甘特网格 —— 选片 → 冲突检测 → 导出 `.ics` 进手机日历 → 一键跳豆瓣。

> **状态**：核心链路（排片网格 / 冲突检测 / 行程 / 选片 / 影片库 / AI 智能排片 / 导出）已实现并部署冒烟通过。
> 当前仓库内置的是**第 30 届（2025）真实排期数据**（699 场 / 29 厅 / 10 天），作为开发与联调基线；
> 2026 第 31 届官方排期发布后，由离线管线解析灌入即可切换。

## 功能

- **甘特排片网格**：影院 × 时间自研 CSS Grid，点选即加入行程；日期快捷条、A/B 双方案隔离；缩放 `− / + / 适应 / 1:1`（影厅列宽与时间刻度同倍率伸缩）
- **冲突检测**：同方案内时间重叠整卡红框 + ⚠；跨馆转场余量三态提示（`ok` / `tight` / `bad`），网格与行程双向 hover 联动
- **我的行程**：按日分组的议程列表，行内切换 必看 / 备选 / 随缘，与网格双向联动
- **我的选片**：按「片」总览全部选片，一部片一条记录（档位在影片级、场次在行程级），支持定位与整片移除
- **影片库**：完整影片目录，单元筛选 chips、中/英/原片名搜索、反向定位、豆瓣评分徽章、场次特性徽章
- **智能排片（AI）**：给影片打标（或直接无片单模式）→ 填入自己的模型 API Key（浏览器直连服务商，本站不经手 Key）→ AI 返回 1~3 个候选方案 + 未纳入原因 → 本地复检剔除冲突后并入 A/B
- **导出**：`.ics`（默认 A 方案，可切 B / 全部）与「抢票顺位清单（复制）」
- **豆瓣**：半自动映射 —— 前端拼搜索链接 + 粘贴链接回填，不做爬虫

## 技术架构

```
离线数据管线（本机 Python，非部署部分）
  官方 Ticket Catalogue PDF / xlsx
    └─ tools/*.py ──► schedule.json / venues.json / films.json（检入仓库）

在线排片应用（Cloudflare Pages + Functions + D1，零服务器成本）
  dist/（Vite 构建）   functions/api/         D1（SQLite）
  schedule.json ───────► pick.js    ──────── user_pick（我的选片）
  venues.json           mapping.js ──────── douban_map（豆瓣映射）
  films.json
  └ 前端（无框架 TS）：grid / agenda / conflict / engine（质量分）/ ai（智能排片）/ ics …
```

- **平台**：Cloudflare Pages + Pages Functions + D1（SQLite），单用户、无鉴权（`robots.txt` 已禁止收录）
- **前端**：Vite + TypeScript，无框架；网格 / 冲突 / 徽章均自研，未引入组件库或付费插件
- **样式**：Tailwind v4 **增量双轨**（不引 preflight）+ 语义 token，BIFF 黑白编辑风，品牌红 `#ce1e36` 仅做交互点缀
- **数据分离**：官方排期 = 只读静态 JSON（版本化、可 diff）；用户选片 / 豆瓣映射 = D1（`user_id` 字段预留多人）
- **AI 隐私**：`functions/` 内不含任何 LLM 代理端点，Key 只放请求头、只落浏览器 localStorage

## 目录结构

```
├─ index.html              # 单页入口
├─ src/                    # TS 源码：grid(排片网格) / agenda(行程) / conflict(冲突检测)
│                          # engine(排片质量分) / ai(智能排片) / library(影片库) / ics / state …
├─ functions/api/          # Pages Functions：pick、mapping 动态路由
├─ migrations/             # D1 迁移：0001_init / 0002_priority_nullable / 0003_user_pick
├─ public/                 # 静态数据：schedule.json / venues.json / films.json / brand/
├─ tools/                  # 离线数据管线（Python / Node，不入部署）
├─ data/                   # 离线中间产物（enriched_douban.json、films-2026.json 等）
├─ docs/                   # CONVENTIONS.md（工程约定）+ plans/ + history/
└─ PLAN.md                 # 活文档：当前状态 / 决策 / 待办 / 架构
```

## 开发与部署

```bash
npm install

npm run dev                 # 本地开发（Vite）
npm run typecheck           # tsc --noEmit
npm run build               # typecheck + vite build
npm run preview             # 构建 + wrangler pages dev dist

# 部署（首次需先建 D1 与 Pages 项目，见 PLAN.md）
npm run migrate:remote      # wrangler d1 migrations apply --remote
npm run deploy              # 构建 + pages deploy 到 production 分支
```

> 改代码前建议先读 `docs/CONVENTIONS.md`（数据契约 / 弹层交互 / 渲染约定）与 `PLAN.md`。

## 数据与许可

- 排期 / 场次信息来源于 biff.kr 公开页面，**仅作个人非商用排片参考**，不收费、不对外分发；footer 已保留出处归属
- `public/brand/` 下的 BIFF 官方 logo 素材（favicon / 字标 / ft_logo）版权归 BIFF 组委会所有，**如转为商业或公开大规模用途需移除并替换**（详见 `PLAN.md` §8）
- 影片目录源为电影节官方影片信息 xlsx，豆瓣评分由 `tools/enrich_douban.py` 慢速回填，缺失即不展示

**Unofficial fan tool, not affiliated with Busan International Film Festival.**
