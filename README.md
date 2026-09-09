# BIFF 2026 排片工具 (biff-scheduler)

个人自用的[第 31 届釜山国际电影节](https://www.biff.kr/)排片工具 —— 官方排期可视化选片 → 冲突检测 → 导出 `.ics` 进手机日历 → 一键跳豆瓣。

> **状态**:M0/M2 核心链路已实现并部署冒烟通过,当前展示 **mock 排期**;官方正式排期 2026-09-11 17:00 KST 发布后,由离线管线解析灌入真数据。

## 功能

- **排片网格**:影院 × 时间自研 CSS Grid(官方排期只读、点选加入行程),日期快捷条 / A/B 双方案一键切换
- **冲突检测**:时间重叠红框斜纹 + 同冲突组 hover 联动;跨馆转场余量三态提示(ok / tight / bad)
- **我的行程**:按日分组议程列表,行内 必看/备选/随缘 即时切换,与网格双向 hover 联动
- **智能排片**:给影片打 wish 标 → 本地确定性求解引擎(A/B 方案 + 评分 + 未纳入原因)→ 一键采纳替换行程
- **影片库**:250 部全目录(单元筛选 chips、中/英/原片名搜索、反向定位、豆瓣评分徽章、场次特性 badge)
- **导出**:`.ics`(默认 A 方案,可切 B/全部)与「抢票顺位清单(复制)」
- **豆瓣**:半自动映射 —— 前端拼搜索链接 + 粘贴链接回填,不做爬虫

## 技术架构

```
离线数据管线(本机 Python,非部署部分)
  官方 Ticket Catalogue PDF / xlsx
    └─ tools/*.py ──► schedule.json / venues.json / films.json(检入仓库)

在线排片应用(Cloudflare Pages + Functions + D1,零服务器成本)
  dist/(Vite 构建)  functions/api/        D1(SQLite)
  schedule.json ───────► plan.js  ──────── user_plan(我的排片)
  venues.json           mapping.js ────── douban_map(豆瓣映射)
  films.json
  └ 前端(无框架 TS):grid / agenda / conflict / engine / ics …
```

- **平台**:Cloudflare Pages + Pages Functions + D1(SQLite),单用户、无鉴权(`robots.txt` 已禁止收录)
- **前端**:Vite + TypeScript,无框架;网格/冲突/徽章均自研,未引入组件库或付费插件
- **数据分离**:官方排期 = 只读静态 JSON(版本化、可 diff);用户排片/豆瓣映射 = D1(预留 `user_id` 便于多人)
- **UI**:对齐 BIFF 官网黑白编辑风,品牌红 `#ce1e36` 仅做交互点缀

## 目录结构

```
├─ index.html              # 单页入口
├─ src/                    # TS 源码:grid(排片网格)/ agenda(行程)/ conflict(冲突检测)
│                          # engine(智能排片)/ library(影片库)/ ics / api / state …
├─ functions/api/          # Pages Functions:plan、mapping 动态路由
├─ migrations/0001_init.sql# D1 建表(user_plan / douban_map)
├─ public/                 # 静态数据:schedule.json / venues.json / films.json / brand/
├─ tools/                  # 离线数据管线(Python,不入部署)
├─ dist/                   # 构建产物(部署目录)
└─ PLAN.md                 # 实施计划与决策记录
```

## 开发与部署

```bash
npm install

npm run dev                 # 本地开发(Vite)
npm run typecheck           # tsc --noEmit
npm run build               # typecheck + vite build

# 部署(首次需先建 D1 与 Pages 项目,见 PLAN.md)
npm run migrate:remote      # wrangler d1 migrations apply --remote
npm run deploy              # 构建 + pages deploy 到 production 分支
```

## 数据与许可

- 排期/场次信息来源于 biff.kr 公开页面,**仅作个人非商用排片参考**,不收费、不对外分发;footer 已保留出处归属
- `public/brand/` 下的 BIFF 官方 logo 素材(favicon / 字标 / ft_logo)版权归 BIFF 组委会所有,**如转为商业/公开大规模用途需移除并替换**(详见 PLAN §15)
- 影片目录源为 2026 第 31 届电影节影片信息 xlsx,豆瓣评分由 `tools/enrich_douban.py` 慢速回填,缺失即不展示

**Unofficial fan tool, not affiliated with Busan International Film Festival.**
