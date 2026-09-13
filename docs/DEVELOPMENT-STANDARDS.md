# biff-scheduler 开发规范(v1 · 2026-09-13 定稿)

> **效力**:本仓库所有改动(人 / AI / 多 agent)一律遵守本文件。
> **配套**:
> - `.codebuddy/rules/biff-development-standards/RULE.mdc` —— 规则摘要(CodeBuddy 自动加载,`alwaysApply`)。
> - `docs/CONVENTIONS.md` —— 具体口径细节(弹层 / 渲染 / 数据契约 / 踩坑),本文件不重复。
> - `PLAN.md` —— 当前状态 + 已拍板决策(活文档)。
> - `skills/` —— 可复用能力(无头验收 / PDF 管线 / 并行安全提交 / Tailwind 产物核对)。
>
> 本文件与 `CONVENTIONS.md` 冲突时,**本文件优先**;发现冲突请在同一个 PR 里改齐两份。

---

## 0. 一句话总纲

**先 PLAN、后实现、写测试、跑门禁、再推送。** 本项目**没有 CI 兜底** —— `git push origin main` 即触发 Cloudflare Workers Builds 上线,所以门禁必须在本机跑绿。

---

## 1. 工作流(五步,不可跳步)

| 步 | 动作 | 产物 / 证据 |
|---|---|---|
| 1 | **写 PLAN** | `docs/plans/PLAN-<YYYYMMDDHHMMSS>.md` |
| 2 | **实现** | 代码 + 单测 / E2E |
| 3 | **验证** | `npm run verify`(必)+ 受影响 spec 的单浏览器 E2E(改 UI 必,见 §2) |
| 4 | **提交推送** | Conventional Commits → `git push origin main` |
| 5 | **回写文档** | `PLAN.md` §0/§6/§7(状态)、本文件 / `CONVENTIONS.md`(口径) |

### 1.1 PLAN 文件(强制)

- 命名:`docs/plans/PLAN-<YYYYMMDDHHMMSS>.md`(时间戳即开始时间)。
- 必含四节:**目标**(要解决什么)· **范围**(改哪些文件/模块,以及**明确不做什么**)· **方案与取舍**(为什么这么选,否掉了什么)· **验收标准**(可执行的命令 + 可观察的结果)。
- 实施中需求变了 → **改 PLAN 文件**,不要在对话里口头改。
- 只读本需求的 PLAN;**不要整读 `PLAN.md` 活文档**(它有 400+ 行,按需读章节)。

### 1.2 改动前必读

1. 本文件(规范)。
2. 本需求的 `PLAN-*.md`。
3. 涉及口径时读 `docs/CONVENTIONS.md` 对应章节。

---

## 2. Push 前门禁

> **红线**:`npm run verify` 未绿,**禁止** `git commit` / `git push`。不接受「先推上去让自动构建兜」。
>
> 门禁**按改动范围分档**:日常改动只跑必跑档(1–3 分钟);全量三浏览器 E2E 属于**发布前体检**,
> 不要求每次 push 都跑 —— 它是上线前的把关,不是每次提交的仪式。

| 档 | 场景 | 命令 | 耗时 |
|---|---|---|---|
| **必跑(每次 push)** | 任何改动 | `npm run verify` | 1–3 min |
| **按需(改了 UI / 交互 / 样式 / 路由)** | 只跑**受影响的 spec**、**单浏览器** | `npx playwright test -c playwright.react.config.ts --project=desktop-chromium e2e/react/<受影响的>.spec.ts` | 10–30 s |
| **发布前(全量)** | 大范围改动 / 动了共享口径(`row.ts` `util.ts` `ui.ts` `chips.ts` `data.ts`) / 对外发布 | `npm run verify:full` | 5–9 min |
| **改了离线管线(`tools/*.py`)** | — | `python3 tools/<script>.py --help` + 跑一遍自检 | 自检输出须与基线数字一致或显式说明差异 |
| **改了数据产物(`apps/web/public/*.json`)** | — | `npm run verify` | 产物必须能被 `data.ts` 正常加载(单测 + 页面不报错) |

补充纪律:

- **单测是 `verify` 的一部分**,不是可选项;新增/修改纯函数口径 → 必须同步改对应 `*.test.ts`。
- 门禁失败时**先定位再改**,禁止「重跑一次看运气」。
- **排查 E2E 失败只跑单文件 + 单浏览器**;全量三浏览器只在确认修复后跑**一次**,不要拿全量重跑做二分。
- E2E 跑完若 `31029` 端口仍被占用,说明 `webServer` 未优雅退出 —— 属配置问题,修配置,不要把 `kill -9` 当常规手段。
- 时间/资源紧张时也不降级**必跑档** —— 宁可缩小提交范围。

---

## 3. 测试规范

### 3.1 分层

| 层 | 位置 | 覆盖对象 |
|---|---|---|
| 单测(Vitest) | `tests/**/*.test.ts`、`apps/web/tests/**` | **纯函数**口径:冲突检测 / GV 时长 / `.ics` / `util` / `plans` / `score` / 状态迁移 |
| E2E(Playwright) | `e2e/react/*.spec.ts`、`e2e/account.spec.ts` | DOM 交互:弹层栈 / 选片链路 / 导出 / 移动端时间轴 / 离线 PWA |

### 3.2 硬要求

- **每个 bug 修复必须带一条能复现原 bug 的回归测试**(先让它红,再修到绿)。
- **断言写「当前实际行为」**;若实现与注释/文档相左,在测试注释里记明分歧,**不要为了让测试变绿去改实现**(范例:`tests/conflict.test.ts` 的 `transitFor` 死参数)。
- 单测**不得有 DOM 副作用依赖**:纯逻辑模块在 import 期不许碰 `document`(需要 DOM 的渲染/剪贴板/下载逻辑单独拆文件,例:`poster.ts` vs `poster-panel.ts`)。
- E2E 断言优先用 **DOM 计数 / class token / 文案精确匹配(`:text-is()`)/ `getBoundingClientRect()`**,不要靠截图看图。
- 写交互验收前先读 SKILL `web-ui-headless-interaction-qa`(里面有 12 条实测坑:过渡中间值、弹层栈深、条件渲染误判等)。
- 验证结果必须**贴出证据**(断言汇总 JSON / 测试计数),不要只说「应该没问题」。

---

## 4. 提交规范

### 4.1 格式

```
<type>(<scope>): <中文描述,一句话说清改了什么>

<为什么改 / 影响面 / 验证结果>(可选 body)
```

- `type` ∈ `feat` `fix` `refactor` `perf` `style` `docs` `test` `chore` `data` `build`。
- `scope` 用模块名:`grid` `agenda` `library` `ics` `plans` `api` `data` `footer` `mobile` …
- 描述用中文,与既有历史一致(例:`fix(schedule): 单影厅日的影厅列不再撑满视口`)。
- **一次提交只做一件事**;不混入无关格式化、无关重构。
- 大改动在 body 里写清**验证命令与结果**(如 `npm run verify:full 通过:218/218`)。

### 4.2 禁止

- ❌ 提交临时文件 / 中间产物:`*.tmp.mjs`、`dist/`、`.wrangler/`、`data/_cache/`、`*.log`、编辑器本地文件。
- ❌ `git push --force` 到 `main`;❌ amend 已推送的提交。
- ❌ 跳过 hooks(`--no-verify`)。
- ❌ 把在途改动「搭车」提交(见 §7 并行协作)。

---

## 5. 前端代码规范(TypeScript / React)

### 5.1 单一来源原则(本仓库最高频的返工来源)

- 任何**口径**(片名 / 日期 / 场次行 / 卡片头 / 转场余量 / GV 时长 / 有效结束时间 / 颜色 token)只允许存在**一处实现**,其余模块 import。
- 新增「另一个视图」时**复用**既有构造器(`row.ts::screeningRow` / `cardHead` / `util.ts::filmInfoOf` …),不要另写一份骨架。
- 共享 UI 类名一律走 `ui.ts` / `chips.ts` 工厂,**禁止**在业务文件里手写按钮字面量。
- `extraCls` 只放布局 / 变体(间距、对齐、`hover:`、`tabular-nums`),**不得**覆盖字号 / 颜色 / 背景 / 圆角。

### 5.2 数据契约

- `localStorage` 的 `biff.*` key **只增不改**;必须改结构时:新增版本 key + 一次性迁移 + **迁移后删除旧 key**(范例:`biff.plan.v1` → `biff.picks.v2`)。
- 片单 / 排片**只存本地**,**不得**回写云端(历史事故:部署换 origin 导致数据复活 / 被覆盖)。
- 午夜场跨天一律 **24+ 时制**(`"29:35"` = 次日 05:35),**任何地方不得对小时取模**;唯一归一化闸门 = `data.ts::loadCatalog()`。

### 5.3 依赖与体积

- 引入任何新依赖前**必须先量化**:gzip 增量 + 实际调用点。成本 > 收益即否决(范例:tailwind-merge 实测 +9.7KB / 0 调用点 → 已撤)。
- 优先自研 / 平台能力,保持「零重依赖」。

### 5.4 样式(Tailwind v4)

- **token 是唯一色源**(`:root` 字面值 → `@theme` 映射);新增颜色先加 token。
- 字阶 / 圆角走**值命名阶梯**(`text-12` / `rounded-8`),**禁止** `text-[Npx]` / `rounded-[Npx]` 任意值。
- 只生成源码里**完整字面量**出现的类 —— 禁止拼 `bg-${p}` 这类动态类名(改不了就内联 `style` / CSS 变量)。
- `@utility` 单类权重 (0,1,0) < `hover:` (0,2,0);JS 运行时打的状态类要覆盖 `hover:` 必须 `!important`。
- 暗色**只覆盖 token**,禁止在暗色块里写组件规则。

### 5.5 React / 组件

- 组件保持**受控 / 无状态优先**;状态提升到路由级或 store,不要在深层组件里藏副本(历史 bug:`SettingsDialog` 用 `useState` 暂存 draft → 取消后重开显示未保存值)。
- 弹层遵守 `role=dialog` + focus trap + 焦点归还 + body 滚动锁;toast 走 `aria-live`。
- 断点三档 **768 / 1099 / 720**,JS(`matchMedia` / `isMobileDrawer()`)与 CSS(`@media`)的值**必须逐字一致**。
- 触屏没有 hover:凡是「常态淡显、hover 显现」的控件必须挂 `ui-icon-btn` 钩子(由 `@media (hover: none)` 拉满)。

### 5.6 注释与文档

- 注释一律**中文**,写**为什么**(约束、踩过的坑、不能这么做的原因),不写「这行在做什么」。
- 复杂模块在文件头写清契约与不变量。
- 新增项目能力 → 同步 `skills/README.md` 与根 `README.md` 的能力表。

### 5.7 离线管线(Python)

- 遵循用户级 Python 规范:PEP8、4 空格、**每行 ≤ 120 字符**、UTF-8 + LF、`with` 管资源、禁止裸 `except:`、公共函数写 docstring 与类型提示。
- 产物**检入仓库**;密钥 / token **只读环境变量**,绝不进仓库。
- 遇到 API 风控(如豆瓣 `{103,1005,1309}`)**必须停轮并保留进度**,禁止把失败写成 `miss`。

---

## 6. 部署规范

- **唯一常规路径**:`git push origin main` → Cloudflare Workers Builds 自动构建上线 `https://biff.lcandy.co`。
- ❌ **禁止** `wrangler pages deploy`(旧 Pages 项目已不在访问链路,传上去没人访问)。
- 部署前确认工作区**没有别人的在途改动**搭车上线(见 §7)。
- 线上核对:
  - 必须带 cache-buster:`curl -sL "https://biff.lcandy.co/<f>.json?cb=$(date +%s)"`。
  - 最强判据 = **asset hash 相同**(不是内容 grep),再交叉 grep 自己新增的字符串 + 一组阴性对照。
- **用户约定**:每次代码改动完成后**必须重新部署**,不需要额外询问。

---

## 7. 并行协作(多会话 / 多 agent 同工作区)

- 提交前**静默确认**:`git log --oneline -1` 比对 HEAD + 连续 **90 秒**无新文件写入,再动手。
- **只提交自己的 hunk**;完整配方见 SKILL `parallel-agent-safe-commit`。
- 有他人在途改动时:走**隔离 worktree**(`git worktree add --detach` + 软链 `node_modules`,收尾 `remove --force`);
  **绝不** `git stash` / `git checkout` 对方的文件。
- 提交前用 `git show HEAD:<file>` 判断自己的改动是否已被对方 commit 带上,别重复提交。
- 自己的改动若落在配套文件里(如 `style.css` 的 token),**整个文件带上**并在 commit message 说明多带了哪几行。

---

## 8. 禁止清单(红线)

1. `npm run verify` 未绿就 commit / push。
2. 无 PLAN 直接动手(除纯错别字 / 单行修复)。
3. 修 bug 不带回归测试。
4. 为了测试变绿而改实现(掩盖真实行为)。
5. 同一个口径写第二份实现。
6. 修改 `biff.*` key 结构不带迁移、或迁移后不删旧 key。
7. 把用户片单写回云端。
8. 对小时取模破坏 24+ 时制。
9. 动态拼 Tailwind 类名 / 使用 `text-[Npx]` 任意值。
10. 未量化就引入新依赖。
11. 提交临时文件、`dist/`、密钥、`data/_cache/`。
12. `wrangler pages deploy` 直传。
13. `git push --force` 到 `main`。
14. 为「看效果」反复起 dev server / 滥用浏览器预览(排查优先读代码;需要证据时用无头断言,用完即停)。
15. 把一次性流水账堆进 `PLAN.md`(应进 `docs/history/` 或本需求 PLAN)。

---

## 9. 变更记录

| 版本 | 日期 | 内容 |
|---|---|---|
| v1 | 2026-09-13 | 首版:五步工作流、push 门禁、测试分层、提交格式、前端/数据/样式/React 规范、部署与并行协作、红线 15 条 |
| v2 | 2026-09-13 | 门禁分档:全量三浏览器 E2E 由「每次 push 必跑」降级为「发布前按需跑」;日常 = `verify` + 受影响 spec 单浏览器;补 webServer 优雅退出纪律 |
