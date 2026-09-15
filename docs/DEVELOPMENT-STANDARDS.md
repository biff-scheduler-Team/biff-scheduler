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

**先 PLAN、后实现、写测试、再推送。测试跑在云端,不在本地。**
`git push origin main` 触发**两条自动化管线**:① **Cloudflare Workers Builds** 跑 `npm run build`
(typecheck → lint → 单测 → 各 workspace 构建),**失败即不上线**;② **GitHub CI**(`.github/workflows/ci.yml`)
跑门禁与 E2E。所以本地**不必**跑门禁 —— 写完 → 提交 → push 即可,`push` 是纯发布动作。

⚠ **代价写在明处**:E2E 只有 CI 跑,而 CI 是**事后**的 —— 它红了**不会回滚已经上线的版本**。
typecheck / lint / 单测仍是**部署前**门禁(Cloudflare 构建不过就不部署);E2E 回归则可能先上线再被发现。
详见 §2。

---

## 1. 工作流(五步,不可跳步)

| 步 | 动作 | 产物 / 证据 |
|---|---|---|
| 1 | **写 PLAN** | `docs/plans/PLAN-<YYYYMMDDHHMMSS>.md` |
| 2 | **实现** | 代码 + 单测 / E2E |
| 3 | **验证(可选)** | 默认交给云端(Cloudflare 构建 + GitHub CI,见 §2);本地想提前看结果才自己跑 |
| 4 | **提交推送** | Conventional Commits → **直接** `git push origin main`(不重跑) |
| 5 | **回写文档** | 文档头「最后更新」一行(**不再追加 `PLAN.md` §0 条目**)、本文件 / `CONVENTIONS.md`(口径) |

### 1.1 PLAN 文件(强制)

- 命名:`docs/plans/PLAN-<YYYYMMDDHHMMSS>.md`(时间戳即开始时间)。
- 必含四节:**目标**(要解决什么)· **范围**(改哪些文件/模块,以及**明确不做什么**)· **方案与取舍**(为什么这么选,否掉了什么)· **验收标准**(可执行的命令 + 可观察的结果)。
- 实施中需求变了 → **改 PLAN 文件**,不要在对话里口头改。
- 只读本需求的 PLAN;**不要整读 `PLAN.md` 活文档**(按需读章节)。
- **`PLAN.md` 不再追加条目**:§0 是**已完成快照,只减不增** —— 新需求只写本需求的 PLAN 文件,
  `PLAN.md` 只在文档头更新一行「最后更新」;需要留痕的历史轮次进 `docs/history/`。

### 1.2 改动前必读

1. 本文件(规范)。
2. 本需求的 `PLAN-*.md`。
3. 涉及口径时读 `docs/CONVENTIONS.md` 对应章节。
4. **提需求 / 变更需求之前**读 §9(与 AI 协作的约定)—— 它管的是需求怎么提,不是代码怎么写。

---

## 2. 验证:跑在云端(本地不跑门禁)

> **原则**:测试由**两条云端管线**负责 —— 本地写完直接 push,不必先跑一遍。
> ⚠ **代价写在明处**:E2E 只有 CI 跑,而 CI 是**事后**的 —— 它红了**不会回滚已经上线的版本**。

| 管线 | 触发 | 跑什么 | 性质 | 失败后果 |
|---|---|---|---|---|
| **Cloudflare Workers Builds** | push `main` 后 | `npm run build` = typecheck → lint → 单测 → 各 workspace 构建 | **部署前门禁** | **不上线**(部署卡住;已推送的提交不回滚) |
| **GitHub CI**(`.github/workflows/ci.yml`) | PR / push `main` / 手动 | PR:`verify:quick` + 受影响 spec(chromium);`main`:**全量三浏览器 E2E** | **PR 门禁 + 事后体检** | **不回滚** —— 版本可能已经上线,只能靠下一条提交修 |

**本地什么时候才需要跑**:

| 场景 | 建议 | 命令 |
|---|---|---|
| 日常改完 | **什么都不用跑**,直接提交 push | — |
| 想 push 前先知道结果 | 跑一次快速门禁 | `npm run verify:quick`(1–2 min) |
| 改的是 UI、且自己没底 | 单 spec 桌面端 | `npm run verify:ui -- e2e/react/<spec>.spec.ts --project=desktop-chromium` |
| 排查 CI 上的 E2E 失败 | **先单文件 + 单浏览器**,别拿全量重跑做二分 | `npx playwright test -c playwright.react.config.ts e2e/react/<spec>.spec.ts --project=desktop-chromium` |

⚠ 这个分工能成立的前提只有两条:① typecheck / lint / 单测仍在**部署前**挡住「代码坏了」;
② **CI 红了要优先修**,别继续叠改动(§8 红线 1)。

### 2.1 为什么本地不必重跑(避免「同一批测试跑三遍」)

Cloudflare 在部署前跑的 `npm run build`,就是 typecheck → lint → 单测 → 构建 —— 与本地 `verify:quick`
**同一批命令**。本地再跑一遍,只是把云端几秒钟后就会给出的结论提前几分钟拿到,
并不改变「坏代码上不了线」这个事实。

`vite build` 同理:本地产物**不会被部署**(Cloudflare 云端重新构建,`dist/` 也在 `.gitignore` 里),
它只是「能打包」的自检,所以从来不是必跑项。

### 2.2 要跑的时候怎么跑(`verify:ui` 一次 build 两用)

E2E 的 `webServer` 跑的是 `vite preview`,吃的是 `dist/`,**所以 E2E 之前必须先 build**;
而 `npm run verify` 里已经 build 过一次 —— 先 `verify` 再 `test:e2e:react` 等于 build 两次(每次约 30–60s)。

改了 UI 只想在本地验一遍,就只跑这一条:

```
npm run verify:ui -- e2e/react/parity-library.spec.ts --project=desktop-chromium
```

= typecheck + lint + 单测 + `build -w @biff/web` + 指定 spec / 浏览器(参数透传给 playwright)。
它已经覆盖门禁,**不要**再补一次 `npm run verify`(除非本轮动到了 `apps/api`,需要验证 worker 打包)。
`verify:full`(5–9 min 三浏览器)只在**确认修复后**跑一次,不要拿它做二分。

- `verify:quick` = typecheck + lint + 单测,**不含 build**,是最快的完整门禁。
- `build -w @biff/web` 只 build web,跳过 `postbuild`(`scripts/prepare-cloudflare.mjs`)——
  它本地只写 `.wrangler/deploy/config.json`、不碰 `dist/`,E2E 不需要它。

**若选择本地跑:测试通过 → push 之间代码必须冻结。** 跑完又改了任何文件,那次结果即失效、等于没测。

### 2.3 与「谁跑」无关的纪律(仍然生效)

- **「受影响 spec」有表可查**:`docs/TEST-MAP.md`(机读唯一来源 `scripts/test-map.json`,
  `node scripts/affected-specs.mjs --check` 断言两者同步,已串进 CI 的 gate)。
  `npm run specs:affected` 按当前 diff 输出必跑 spec。⚠ 无参数时它按 `origin/main...HEAD`(已提交差异)算,
  **尚未提交的改动要用 `--files <path>`**,否则会误报「无改动」。
- **单测是与实现同批交付的产物**,不是可选项;新增 / 修改纯函数口径 → 必须在同一条提交里改对应 `*.test.ts`。
- **排查 E2E 失败只跑单文件 + 单浏览器**;全量三浏览器只在确认修复后跑**一次**,不要拿全量重跑做二分。
- E2E 跑完若 `31029` 端口仍被占用,说明 `webServer` 未优雅退出 —— 属配置问题,修配置,不要把 `kill -9` 当常规手段。
- 改了离线管线(`tools/*.py`)→ **本地**跑一遍脚本自检,输出须与基线数字一致或显式说明差异
  (这类脚本不在 Cloudflare 构建与 CI 的覆盖里,是本文件里少数仍然必须本地验的东西)。
- 改了数据产物(`apps/web/public/*.json`)→ 产物必须能被 `data.ts` 正常加载(本地跑 `npm run verify`,
  或等 CI —— 它同样覆盖)。
- 报告结果必须**贴证据**(CI 运行链接 / 测试计数 / 断言汇总),不要只说「应该没问题」——
  本地跑了就贴本地计数,没跑就贴 CI 结果,不要写成「应该能过」。

---

## 3. 测试规范

### 3.1 分层

| 层 | 位置 | 覆盖对象 |
|---|---|---|
| 单测(Vitest) | `apps/web/tests/**`、`apps/api/tests/**`、根 `tests/**` | **纯函数**口径:冲突检测 / GV 时长 / `.ics` / `util` / `plans` / `score` / 状态迁移 / 账号加解密与配置校验 / 共享序列化 |
| E2E(Playwright) | `e2e/react/*.spec.ts`、`e2e/account.spec.ts` | DOM 交互:弹层栈 / 选片链路 / 导出 / 移动端时间轴 / 离线 PWA |

### 3.2 硬要求

- **每个 bug 修复必须带一条能复现原 bug 的回归测试**(先让它红,再修到绿)。
- **断言写「当前实际行为」**;若实现与注释/文档相左,在测试注释里记明分歧,**不要为了让测试变绿去改实现**(范例:`tests/conflict.test.ts` 的 `transitFor` 死参数)。
- 单测**不得有 DOM 副作用依赖**:纯逻辑模块在 import 期不许碰 `document`(需要 DOM 的渲染/剪贴板/下载逻辑单独拆文件,例:`poster.ts` vs `poster-panel.ts`)。
- E2E 断言优先用 **DOM 计数 / class token / 文案精确匹配(`:text-is()`)/ `getBoundingClientRect()`**,不要靠截图看图。
- 写交互验收前先读 SKILL `web-ui-headless-interaction-qa`(里面有 12 条实测坑:过渡中间值、弹层栈深、条件渲染误判等)。
- 报告结果必须**贴证据**(断言汇总 JSON / CI 运行链接 / 测试计数),不要只说「应该没问题」。

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

### 4.3 机械约束(git hooks)

| 钩子 | 做什么 | 成本 |
|---|---|---|
| `commit-msg` | 校验 `<type>(<scope>): <描述>`;放行 Merge / Revert / `fixup!` / `squash!` / `amend!` 系列 | 即时 |

由 `scripts/install-git-hooks.mjs` 安装,挂在 `package.json` 的 `prepare` 上 —— `npm install` 后自动生效;
手动重装 `npm run hooks:install`。该脚本**任何情况下都不让构建失败**(Cloudflare 的 `npm ci` 也会跑它,
那里没有 `.git` 就静默跳过);它还会**清理已下线的托管钩子**(源目录里删掉的名字会从 `.git/hooks` 一并移除,
只碰它自己装过的那几个,不动别人的钩子)。

**为什么没有 `pre-push`**(2026-09-16 删,`PLAN-20260916003228`):它原本跑 `verify:quick` 当本地门禁,
但那一批检查 `npm run build` 在 Cloudflare 上**部署前**已经跑过一遍(§2),本地再跑不改变任何结果,
只是让每次 push 多等 40 秒。本地门禁取消后:坏代码由 Cloudflare 构建挡、E2E 由 CI 报,职责全在云端;
本地只留**即时**的提交格式校验。

**为什么自写而不用 husky + commitlint**:本仓库的格式是自定义的(type 白名单 + 小写 scope + 中文描述),
自写 ~40 行零依赖即可,不值得为它引两个依赖 + 一层 `prepare` 生命周期(见 §5.3「未量化不引依赖」)。

### 4.4 会话草稿的落点(工具中立)

AI 助手的会话草稿(`findings.md` / `progress.md` / `task_plan.md` / `notes.md` 一类)**不落仓库根**,
一律落 **`.scratch/`**(已 gitignore)。

**落点必须工具中立**:不得写成 `.codebuddy/`、`.workbuddy/` 这类**单个 IDE 的目录** ——
协作者可能用 Codex / Cursor / 别的助手,绑定一家等于对其他人失效。

根目录是**白名单制**,由机械检查兜底:

```sh
npm run check:repo              # 已串进 verify:quick / verify
node scripts/check-repo.mjs --self-test   # 自检:证明检查器本身没坏
```

> 背景(2026-09-13,`PLAN-20260913201727`):`findings.md`(26 行)/ `progress.md`(69 行)/
> `task_plan.md`(74 行)三个会话草稿被提交进根目录(`fe82988` / `14c29b1`),违反本节第一条却**无人发现**
> —— 因为它们长得不像临时文件。**能机械拦住的,不要留给自觉。**

### 4.5 PR 流程(大改动走 PR,小改动直接 push)

**默认仍是直接 `push main`**(§0 / §2)。**必须走 PR** 的只有三类:

| 走 PR 的改动 | 为什么 |
|---|---|
| **大规模重构 / 跨视图改造**(§9.3 第二档) | 需要 Review 记录 + 「零影响」逐条核对;CI 在**合并前**跑,而不是合并后才发现 |
| 涉及 `apps/api` 或 **D1 迁移** | 迁移**不可逆**;而 `prepare-cloudflare.mjs` 只在 `WORKERS_CI_BRANCH=main` 时迁移 + 部署 → **PR 分支天然不碰生产** |
| **依赖升级** | Dependabot 自动开 PR(§5.3);`package-lock.json` 命中 TEST-MAP 的 `allOn`,这类 PR 会跑全量 E2E |

**PR 比直接 push 多出来的三样东西**(即 `citron` 那批提交的形态):

1. **Review 记录** —— 谁在什么时候看过哪一版(`Merge pull request #9 from biff-scheduler-Team/…`)。
2. **Verified 签名** —— 提交带签名时 GitHub 显示 `Verified`;直接 push 的本地提交默认是 `Unverified`。
   零配置做法 = 在 GitHub 网页上完成 merge(产生的提交由 GitHub web-flow 签名);
   想让**本地提交**也 Verified,配一次即可:

   ```sh
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/id_ed25519.pub
   git config --global commit.gpgsign true
   ```

   然后把同一把公钥作为 **Signing Key** 加到 GitHub(与 Authentication Key 分开登记)。
3. **CI 在合并前跑** —— PR 上跑 `verify:quick` + 受影响 spec(单浏览器);`main` push 才跑全量三浏览器。
   ⚠ 但 **PR 不能替代本地门禁**:§2 的口径不变 —— 测试仍在**开发阶段**跑完,CI 只负责挡住「人漏了」。

**与 §2「推的时候直接推」不冲突**:PR merge 到 `main` 就是一次 push main,照样触发 Workers Builds;
「推的时候直接推」管的是 **merge 那一刻**不要再重跑完整门禁。

**分支命名**:`fix/<范围>` / `feat/<范围>`(与 `fix/main-mobile-e2e` / `feat/desktop-split-account-want` 同形)。

### 4.6 checkpoint 提交(大重构前先留干净落点)

**什么时候打**:§9.3 第二档(大规模重构 / 跨视图改造)**动手前**;或一次要动 > 20 个文件、
要碰 `state.ts` / `style.css` / `grid.ts` 这类高耦合文件时。

**格式**:`chore(<scope>): checkpoint before <重构名>`
(范例:`4feda07 chore: checkpoint before integrating React scheduler`)。

**三条硬要求**:

1. **checkpoint 自身必须全绿** —— `npm run verify:quick` 通过。否则别人 `git pull` 到的是坏 HEAD(§7)。
2. **不含半成品** —— 未完成的重构残留、调试代码、被注释掉的旧实现一律不进 checkpoint。
   它是「已知良好状态」,不是「先随便存一下」。
3. **打完立即开重构**,checkpoint 与重构的首个提交之间不夹无关改动。

**它买到什么**:出问题时 `git reset --hard <checkpoint>` 一次回到已知良好状态 ——
不必在一堆「重构 + 顺带修复 + 格式化」的混合改动里逐 hunk 挑拣。

⚠ **checkpoint 不能替代原子提交(§4.1)**:它只保证「能回去」,不保证「能干净地回退其中某一部分」。
反例:`4feda07` 打了 checkpoint,但紧随其后的 `fe82988` 是 **128 文件 / 18806 行**的单提交 ——
checkpoint 起作用了,粒度问题依然在。**两者要一起用。**

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
- **升级走 Dependabot**(`.github/dependabot.yml`):按月跑、按 `react` / `tooling` 分组、
  提交信息 `build(<dep>): …`。一次只合一组,合并前必须让 CI 绿 ——
  `package-lock.json` 命中 `docs/TEST-MAP.md` 的 `allOn`,所以这类 PR 会跑全量 E2E。
  **不要手动「顺手升一下」** pin 死的版本(`wrangler` / `@playwright/test` 等):
  那样既没有 changelog 上下文,也绕过了分组升级的节奏。

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

### 5.7 `legacy/` —— 只读回退件

`apps/web/legacy/` 是 React 重写前的原版界面,冻结在 `8a95215`,挂在 `/legacy/`,
是「新版出 P0 时同域、同 localStorage 的逃生舱」。12598 行,每轮构建都产出
(`dist/assets/legacy-*.js` 174.70 kB + CSS 45.31 kB)。

- **只接 P0 修复**(数据丢失 / 完全打不开),不接新功能、不接体验优化。
- **不得**把新版 React 组件或样式引入它。
- 改动必须同步更新 `legacy/source-manifest.json` —— `apps/web/tests/legacy-snapshot.test.ts`
  逐文件比对 SHA-256,**不要为了让测试变绿去改测试**。
- 不为它新增交互用例;`legacy.spec.ts` / `compatibility.spec.ts` 只保留「还能打开」与
  「与新版权共享数据」这两层语义。
- 冻结条款、退役判据(时间窗 / 访问量窗)与 8 步退役清单见 [`legacy-retirement.md`](./legacy-retirement.md)。

### 5.8 离线管线(Python)

- 遵循用户级 Python 规范:PEP8、4 空格、**每行 ≤ 120 字符**、UTF-8 + LF、`with` 管资源、禁止裸 `except:`、公共函数写 docstring 与类型提示。
- 产物**检入仓库**;密钥 / token **只读环境变量**,绝不进仓库。
- 遇到 API 风控(如豆瓣 `{103,1005,1309}`)**必须停轮并保留进度**,禁止把失败写成 `miss`。

---

## 6. 部署规范

- **唯一常规路径**:`git push origin main` → Cloudflare Workers Builds 自动构建上线 `https://biff.lcandy.co`。
- ❌ **禁止** `wrangler pages deploy`(旧 Pages 项目已不在访问链路,传上去没人访问)。
- **PR / 预览分支不部署**:`scripts/prepare-cloudflare.mjs` 只在 `WORKERS_CI_BRANCH=main` 时执行生产 D1 迁移
  并部署前端 Worker,所以 PR 分支的构建**不会**碰生产、也不会上线;生产只发生在 merge 到 `main` 之后(§4.5)。
- 部署前确认工作区**没有别人的在途改动**搭车上线(见 §7)。
- 线上核对:
  - 必须带 cache-buster:`curl -sL "https://biff.lcandy.co/<f>.json?cb=$(date +%s)"`。
  - 最强判据 = **asset hash 相同**(不是内容 grep),再交叉 grep 自己新增的字符串 + 一组阴性对照。
- **用户约定**:每次代码改动完成后**必须重新部署**,不需要额外询问。

---

## 7. 并行协作(多会话 / 多 agent 同工作区)

- **开工前先同步远端**(用户 2026-09-14 约定):先 `git fetch` 看远端是否领先,领先就 `git pull --rebase origin main`,
  冲突在**动手写代码之前**解决完;开发中途远端又有新提交,提交前再拉一次。
  理由:实测过「写完 + 跑完测试,推送时才发现远端被 PR 领先」—— 冲突发现得越晚,rebase 后整轮门禁都得重跑。
- 提交前**静默确认**:`git log --oneline -1` 比对 HEAD + 连续 **90 秒**无新文件写入,再动手。
- **只提交自己的 hunk**;完整配方见 SKILL `parallel-agent-safe-commit`。
- 有他人在途改动时:走**隔离 worktree**(`git worktree add --detach` + 软链 `node_modules`,收尾 `remove --force`);
  **绝不** `git stash` / `git checkout` 对方的文件。
- 提交前用 `git show HEAD:<file>` 判断自己的改动是否已被对方 commit 带上,别重复提交。
- 自己的改动若落在配套文件里(如 `style.css` 的 token),**整个文件带上**并在 commit message 说明多带了哪几行。

---

## 8. 禁止清单(红线)

1. **云端红了(Cloudflare 构建 / CI)还继续叠改动** —— 先修再往下做。本地不跑门禁是允许的(§2),
   但云端报了红当没看见不行。
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
15. 往 `PLAN.md` 追加条目 / 堆一次性流水账(应进本需求 PLAN;历史轮次进 `docs/history/`)。

---

## 9. 与 AI 协作的约定(需求怎么提 / AI 交什么)

### 9.1 为什么要有这一节

§0–§8 定义的是「AI 拿到需求**之后**怎么做」。实践里最贵的返工**不发生在实现阶段,而发生在需求转述阶段**:

> 用户原话:「极端的适配要怎么做 现在移动端的话 一打开就是一个很大的一个影片库 然后就把那个甘特图挡住了」

如果只把默认落点从「影片库」改成「行程」,抱怨会原样复发 —— 真正的成因是「**手机上缺一个可用的时间轴形态**」
(`PLAN-20260912002532` §1)。这类误判不是模型能力问题,是**需求输入里缺了约束**。
所以本节把「怎么提」也变成规范。

### 9.2 一句话原则

**人只描述「症状 + 约束」,不指定实现;AI 先读代码把症状还原成机制,再给方案。**
一切产物落成**文件**(PLAN / 测试 / 注释),不留在对话里 —— 对话会丢,文件不会。

### 9.3 三档需求:怎么提 / AI 必须先交什么 / 收口证据

| 档位 | 人怎么说 | AI 必须先交 | 收口证据 |
|---|---|---|---|
| **普通功能 / bug** | 「<入口> 现在 <现象>,应该 <期望>;不要动 <范围>」+ 截图或原话 | PLAN(四节,见 §9.5)→ 代码 + 回归测试 | 单测计数 + 受影响 spec 全绿 |
| **大规模重构 / 跨视图改造** | 「<症状>」+「硬约束:不能影响 <X>」+「先出 PLAN 再实现」 | 现状(代码事实 + 行号,**禁止推测**)/「为什么当初这么设计」/ 形态取舍表(采纳 vs 否决 + 理由)/ 集成点清单(既有机制逐条怎么处理)/ 复用清单 / 明确不做 / 「零影响」的核对手段 / **动手前先打 checkpoint(§4.6)** | 单一开关 + 逐处守卫 + 逐 hunk 复核 |
| **推送 / 发布** | 不用提 —— 按 §2 / §6 默认执行 | 无(测试已在开发阶段跑完) | 测试计数 / asset hash |

**大重构那一档的「必须先交」逐条有出处**(以 `PLAN-20260912002532` 为范例):

| 交付项 | 该 PLAN 里的样子 |
|---|---|
| 现状 = 代码事实 | §1「均为实读,非推测」,精确到 `main.ts` 第 1093 行 / `style.css` 第 518–525 行 |
| 为什么当初这么设计 | §1 回溯到 `PLAN-20260910235000` §2.4,而不是直接推翻 |
| 形态取舍表 | §2.2 `(a) 真时间轴 ❌ / (b) 流式列表 + 时间轨 ✅`,每行带理由 |
| 集成点清单 | §2.2 表格逐条列出 13 个既有机制在新形态下的处理(`drawConflictLinks` 不画 / `#zoom-ctl` 隐藏 / `hourFilter` 恒为 null …) |
| 复用清单 | §1「既有可复用资产(避免重造)」:先盘点能用的构造器,再决定写什么 |
| 明确不做 | §3「不改 `grid.ts` / 不改 `style.css` / 不改断点 / 不做虚拟滚动」 |
| 零影响的核对手段 | §6「单一开关 + 逐处守卫」,6 条可核对条款 + 提交前逐 hunk 复核 |

**大重构的启动动作 = 先打 checkpoint(§4.6)**:`chore(<scope>): checkpoint before <重构名>`,全绿后再开重构。
`PLAN-20260912002532` 的对应形态是「`grid.ts` / `style.css` 一行不改 + 所有新逻辑挂在 `isMobileDrawer()` 之后」——
即**用单一开关保住旧路径**,与 checkpoint 是同一目的的两层保险(一层能回退,一层能共存)。

### 9.4 五条话术纪律

1. **不指定实现。** 说「地图入口要像豆瓣那样紧贴地名」,不要说「把 `margin-left` 去掉」——
   后者会挡掉更好的解法,也会让 AI 停止读代码。
2. **说清「不能影响什么」。** 硬约束比需求本身更能防返工。范例:用户原话「**不能影响现在 PC 端的使用和交互**」,
   在 `PLAN-20260912002532` 里被展开成 §6 一整节(所有新逻辑挂在 `isMobileDrawer()` 之后、`grid.ts` 一行不改、
   `style.css` 一行不改、桌面两条行为逐字保留)。
3. **需求变了改 PLAN 文件** —— 追加 `## 修订 N(日期,触发原因)` 段,不要只在对话里改。
   范例:`PLAN-20260913184357` 的「## 修订 1(2026-09-13,用户看效果后)」。
4. **给 AI 反驳你诊断的空间。** 症状是你观察到的,**成因不是你诊断的**;AI 归因不同时应直接说并给证据。
5. **长期约定一次讲清,写进本文件**(范例:§6「每次改动完成后必须重新部署,无需再问」)——
   之后不再重复叮嘱,也避免 AI 每轮重新猜。

### 9.5 PLAN 模板(可直接复制)

```markdown
# PLAN-<YYYYMMDDHHMMSS> — <一句话目标>

## 目标
<要解决什么。用户原话用引用块贴上来,不要转述。>

## 范围
**做:** …
**不做:** …        ← 与「做」同等重要;写不出来说明范围还没收敛

## 方案取舍
| 备选 | 结论 | 理由 |
|---|---|---|
| … | 采纳 / 否决 | … |

## 验收标准
1. <可观察的结果>
2. <可执行的命令>
```

### 9.6 交付物清单(缺一即返工)

- PLAN 文件(§9.5 模板);**需求变更 = 追加修订段**,不是新开 PLAN。
- 回归测试,且**先红后绿** —— 红的那次要把失败值贴出来(范例:去掉 `margin-left: auto` 前实测
  `gap = 878.1875px`,失败;改后通过)。
- 验证证据(测试计数 / 断言汇总 / asset hash),不许说「应该没问题」。
- 「不做」清单 —— 没写「不做」等于范围无限。
- 回写文档:**新需求只写本需求 PLAN**;`PLAN.md` 只更新文档头一行「最后更新」(**§0 只减不增**);
  本文件 / `docs/CONVENTIONS.md`(口径变更)。

### 9.7 反模式(这样做会返工)

| 反模式 | 为什么坏 | 改成 |
|---|---|---|
| 「帮我优化一下这个页面」 | 没有症状 / 约束 / 验收 —— AI 只能猜,猜完你还不认 | 「<入口> 现在 <现象>,应该 <期望>;不要动 <范围>」 |
| 「把 X 改成 Y」 | 直接给实现,等于替 AI 关掉「读代码」这一步;真正的成因可能根本不在这 | 说症状,让 AI 给方案与取舍表 |
| 只在对话里改需求 | 下一轮上下文丢失后,AI 会照旧 PLAN 走,旧口径复活 | 追加 `## 修订 N` 段 |
| 「顺便把 Z 也改了吧」 | 一次提交只做一件事;搭车改动让回归范围不可控 | 另开 PLAN |
| 让 AI「先做出来我看看」 | 没有验收标准的实现无法判定「完成」 | 先写 PLAN 的「验收标准」 |
| 只说「要做什么」不说「不能影响什么」 | 硬约束缺失是返工第一来源 | 显式写出「不能影响 <X>」 |

---

## 10. 变更记录

| 版本 | 日期 | 内容 |
|---|---|---|
| v1 | 2026-09-13 | 首版:五步工作流、push 门禁、测试分层、提交格式、前端/数据/样式/React 规范、部署与并行协作、红线 15 条 |
| v2 | 2026-09-13 | 门禁分档:全量三浏览器 E2E 由「每次 push 必跑」降级为「发布前按需跑」;日常 = `verify` + 受影响 spec 单浏览器;补 webServer 优雅退出纪律 |
| v3 | 2026-09-13 | 明确「测试在开发阶段跑完,push 时直接推」:删除「push 前必须重跑门禁」的要求,改为「测试通过 → push 之间代码冻结」;红线 1 相应改写 |
| v4 | 2026-09-13 | 新增 §2.1:说明 `vite build` 只验证「能打包」(本地产物不被部署),不是每次改动的必跑项;typecheck / lint / 单测才是每次必过 |
| v5 | 2026-09-13 | 新增 §9「与 AI 协作的约定」:补齐上游那一半(需求怎么提 / 变更怎么记 / 交付物清单 / 反模式);原 §9 变更记录顺延为 §10 |
| v6 | 2026-09-13 | 把规范变成闸门(PLAN-20260913201727):§2 补「受影响 spec 有表可查」与 CI 兜底;§3.1 单测分层补 `apps/api/tests`;§4.3 新增 git hooks(commit-msg + pre-push);§4.4 会话草稿落点工具中立 + `check:repo`;§5.3 依赖升级走 Dependabot;§5.7 新增 `legacy/` 只读回退件(原「离线管线」顺延为 §5.8) |
| v7 | 2026-09-14 | 补两条来自提交复盘的做法(`PLAN-20260914101945`):**§4.5 PR 流程**(大规模重构 / `apps/api` 与 D1 迁移 / 依赖升级三类走 PR,换 Review 记录 + Verified 签名 + 合并前 CI)、**§4.6 checkpoint 提交**(大重构前留全绿落点,且不能替代原子提交);§6 补「PR 分支不部署」;§9.3 大重构档位补 checkpoint 启动动作 |
| v8 | 2026-09-14 | §7 补「开工前先同步远端」(用户约定):先 `git fetch`,远端领先就 `git pull --rebase origin main`,冲突在**动手写代码之前**解决完;避免「写完 + 跑完测试、推送时才发现远端领先」导致 rebase 后整轮门禁重跑 |
| v9 | 2026-09-16 | **测试职责全部移到云端**(`PLAN-20260916003228`):删掉 `pre-push` 本地门禁(§4.3 钩子表同步);§0 / §1 / §2 改写为「本地不跑门禁 —— Cloudflare 构建挡部署、GitHub CI 跑 E2E」,并写明**E2E 是事后的、不会回滚已上线版本**这一代价;§2 新增「为什么本地不必重跑」与「要跑的时候怎么跑」;§8 红线 1 由「没跑过测试就 push」改为「云端红了还继续叠改动」 |
