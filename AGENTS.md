# AGENTS.md — biff-scheduler 开发规范(强制)

> 本文件是仓库**受版本控制**的规范入口,对所有协作者与 AI 助手生效。
> 完整版(含示例与论证)见 [`docs/DEVELOPMENT-STANDARDS.md`](./docs/DEVELOPMENT-STANDARDS.md);
> 具体口径细节见 [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md);当前状态与决策见 [`PLAN.md`](./PLAN.md)。
> 三者冲突时以 `docs/DEVELOPMENT-STANDARDS.md` 为准。
> 本机 CodeBuddy 另有一份自动加载副本:`.codebuddy/rules/biff-development-standards/RULE.mdc`(该目录被 gitignore,需手动同步)。

## 0. 总纲

**先 PLAN → 后实现 → 写测试 → 再推送。测试跑在云端,不在本地。**
`git push origin main` 触发**两条自动化管线**:① **Cloudflare Workers Builds** 跑 `npm run build`
(= typecheck → lint → 单测 → 各 workspace 构建),**失败即不上线**;② **GitHub CI** 跑门禁与 E2E。
所以本地**不必**跑门禁 —— 写完 → 提交 → push 即可,`push` 是纯发布动作。
⚠ **代价**:E2E 只有 CI 跑,而 CI 是**事后**的 —— 红了**不会回滚已上线的版本**;
typecheck / lint / 单测仍是**部署前**门禁。详见 §2。

## 1. 五步工作流(不可跳步)

1. **写 PLAN**:`docs/plans/PLAN-<YYYYMMDDHHMMSS>.md`,必含 目标 / 范围(含「不做什么」)/ 方案取舍 / 验收标准
   (模板见 §9.3)。需求变了改 PLAN 文件,不要只在对话里改。**只读本需求的 PLAN,不整读 `PLAN.md` 活文档。**
   需求**怎么提**、AI **必须交什么**见 §9。
2. **实现**:代码 + 同步单测 / E2E。
3. **验证(可选)**:默认交给云端(Cloudflare 构建 + GitHub CI),见 §2;本地想提前看结果才自己跑。
4. **提交推送**:Conventional Commits → **直接推**,见 §4。
5. **回写文档**:**新需求只写 `docs/plans/PLAN-<时间戳>.md`;`PLAN.md` 只在文档头更新一行「最后更新」,
   不再追加 §0 条目**(§0 = 已完成快照,**只减不增**);口径变更同步 `docs/CONVENTIONS.md`。

## 2. 验证:跑在云端(本地不跑门禁)

> **原则**:测试由**两条云端管线**负责 —— 本地写完直接 push,不必先跑一遍。
> ⚠ 代价写明:E2E 只有 CI 跑,而 CI 是**事后**的,红了**不回滚已上线版本**(完整版见 `docs/DEVELOPMENT-STANDARDS.md` §2)。

| 管线 | 跑什么 | 性质 |
|---|---|---|
| **Cloudflare Workers Builds**(push `main` 后) | `npm run build` = typecheck → lint → 单测 → 各 workspace 构建 | **部署前门禁**,失败不上线 |
| **GitHub CI**(`.github/workflows/ci.yml`) | PR:`verify:quick` + 受影响 spec(chromium);`main`:全量三浏览器 E2E | **PR 门禁 + 事后体检**,不回滚 |

| 时机 | 做什么 | 命令 |
|---|---|---|
| 日常改完 | **什么都不用跑**,直接提交 push | — |
| 想 push 前先知道结果 | 跑一次快速门禁 | `npm run verify:quick` |
| 改了 UI 且自己没底 | 单 spec 桌面端 | `npm run verify:ui -- e2e/react/<spec>.spec.ts --project=desktop-chromium` |
| 排查 CI 上的 E2E 失败 | **先单文件 + 单浏览器**,不要拿全量重跑做二分 | `npx playwright test -c playwright.react.config.ts e2e/react/<spec>.spec.ts --project=desktop-chromium` |

- `verify` / `verify:ui` / `verify:full` 仍是**按需可用**的工具(没有删),只是不再「必跑」。
- **要跑就只跑一条**:`verify:ui` = typecheck + lint + 单测 + `build -w @biff/web` + 指定 spec,
  不要再补 `npm run verify`(除非本轮动到了 `apps/api`,需要验证 worker 打包);
  `verify:full`(5–9 min 三浏览器)只在**确认修复后**跑一次。
- `check:repo` / `check:test-map` 仍在 `verify:quick` 里,CI 的 gate 也跑它们 —— 本地不跑就会被 CI 挡。
- **「受影响 spec」有表可查**:`docs/TEST-MAP.md`(机读源 `scripts/test-map.json`)。
  ⚠ `npm run specs:affected` 无参数时按 `origin/main...HEAD`(已提交差异)算,未提交的改动要用 `--files <path>`。
- **CI / Cloudflare 红了先修再叠改动**(§8 红线 1);报告结果要**贴证据**(CI 链接 / 测试计数),别说「应该没问题」。
- 若选择本地跑,则「测试通过 → push 之间代码必须冻结」—— 跑完又改了任何文件,那次结果即失效。

## 3. 测试要求

- **每个 bug 修复必须带一条能复现原 bug 的回归测试**(先红后绿)。
- 断言写「当前实际行为」;实现与注释相左时在注释里记明分歧,**不得为让测试变绿去改实现**。
- 纯逻辑模块 import 期禁止碰 DOM;E2E 用 DOM 计数 / class token / `:text-is()`,不靠截图。
- 写交互验收前读 SKILL `web-ui-headless-interaction-qa`。

## 4. 提交规范

`<type>(<scope>): <中文一句话描述>`,`type` ∈ `feat` `fix` `refactor` `perf` `style` `docs` `test` `chore` `data` `build`。

- 一次提交只做一件事;body 写「为什么 + 验证结果」。
- 禁止:提交临时文件 / `dist/` / `data/_cache/` / 密钥;`push --force` 到 `main`;amend 已推送提交;`--no-verify`;把他人改动搭车提交。
- **会话草稿不落仓库根**:一律落 `.scratch/`(已 gitignore)。落点必须**工具中立** ——
  不得指定 `.codebuddy/` / `.workbuddy/` 这类单个 IDE 的目录,同事可能用别的助手。
  根目录是**白名单制**,由 `npm run check:repo`(`scripts/check-repo.mjs`,已串进 `verify:quick` / `verify`)机械拦截。
- **钩子(机械约束)**:`npm install` 会自动装(`prepare` → `scripts/install-git-hooks.mjs`,手动重装 `npm run hooks:install`)。
  只留 `commit-msg`(校验本节格式,即时);**`pre-push` 已于 2026-09-16 删除** —— 它原来跑的 `verify:quick`
  在 Cloudflare 构建里**部署前**已经跑过一遍(§2),本地再跑只是让每次 push 多等 40 秒。
  安装脚本会连带**清理已下线的托管钩子**(只碰它自己装过的名字)。
- **大改动走 PR**(完整版见 `DEVELOPMENT-STANDARDS.md` §4.5):默认仍直接 push main;**大规模重构 /
  涉及 `apps/api` 或 D1 迁移 / 依赖升级**三类走 PR —— 换 Review 记录 + Verified 签名 + 「CI 在合并前跑」。
  `prepare-cloudflare.mjs` 只在 `WORKERS_CI_BRANCH=main` 时迁移 + 部署,PR 分支天然不碰生产;
  merge 到 main 才部署,§2「推的时候直接推」不变。
- **大重构前先打 checkpoint**(完整版见 §4.6):`chore(<scope>): checkpoint before <重构名>`,
  自身必须**全绿**、不含半成品;作用是出问题时 `git reset --hard <checkpoint>`。
  **它不能替代原子提交** —— 只保证「能回去」,不保证「能干净地回退其中某一部分」。

## 5. 代码规范

- **口径单一来源**:片名 / 日期 / 场次行 / 卡片头 / 转场余量 / GV 时长 / 有效结束时间 / 颜色 token 只允许一处实现。
  新增视图复用既有构造器(`row.ts` / `util.ts` / `ui.ts` / `chips.ts`),不要另写骨架。
- **数据契约**:`biff.*` key 只增不改;改结构必须「新 key + 一次性迁移 + 删旧 key」。
  **片单默认只存本地**;仅当用户**主动登录 IFFDAY** 后,才同步到 `festival_document` 里**该账号自己
  (`subject` 隔离)**的那一份 —— **不得未经登录就上传,不得写入任何共享 / 非本人位置**;
  账号相关的 localStorage 键走 `iffday.workspace.*` 命名空间,**不占 `biff.*`**。
- **24+ 时制**:午夜场 `"29:35"` = 次日 05:35,**不得对小时取模**;唯一归一化闸门 `data.ts::loadCatalog()`。
- **依赖**:引入前量化 gzip 增量 + 实际调用点,成本 > 收益即否决。
  **升级走 Dependabot**(`.github/dependabot.yml`,按月分组,`build(<dep>): …` 形态)——
  一次只合一组,合并前必须让 CI 绿(`package-lock.json` 命中 TEST-MAP 的 allOn,PR 会跑全量 E2E)。
  不要手动「顺手升一下」某个 pin 死的版本(如 `wrangler` / `@playwright/test`)。
- **Tailwind v4**:token 是唯一色源;字阶 / 圆角走 `text-12` / `rounded-8`,禁止 `text-[Npx]` 任意值;
  只写字面量类名(禁止拼 `bg-${p}`);`@utility` 权重低于 `hover:`,JS 状态类需 `!important`;暗色只覆盖 token。
- **React**:受控 / 无状态优先,禁止组件内藏状态副本;弹层 `role=dialog` + focus trap + 焦点归还;
  断点 768 / 1099 / 720 的 JS 与 CSS 值逐字一致;「常态淡显 hover 显现」的控件挂 `ui-icon-btn`。
- **`legacy/` 是只读回退件**:只接 P0 修复(数据丢失 / 完全打不开),不接新功能;
  不得引入新版 React 组件 / 样式;改它必须同步更新 `legacy/source-manifest.json`
  (否则 `apps/web/tests/legacy-snapshot.test.ts` 会红)。冻结条款与退役判据 / 步骤见 `docs/legacy-retirement.md`。
- **注释一律中文,写「为什么」**。
- **Python 离线管线**:PEP8、4 空格、每行 ≤ 120 字符、`with` 管资源、禁止裸 `except:`、写 docstring 与类型提示;
  产物检入仓库,密钥只读环境变量;遇 API 风控必须停轮保进度,不得把失败写成 `miss`。

## 6. 部署

- **唯一常规路径:`git push origin main`**。完整链路(两个 Worker + 一次生产迁移都在里面):
  1. Workers Builds 跑 `npm run build`(typecheck → lint → 单测 → 各 workspace 构建);
  2. 成功后 npm 自动跑 `postbuild`(`scripts/prepare-cloudflare.mjs`)——**仅当 `WORKERS_CI_BRANCH=main`**
     时执行生产 D1 迁移 `db:migrate:remote` 并部署前端 Worker `biff-scheduler-web`;
     本地构建与预览分支**不迁移、不部署**;
  3. 最后由仓库原有的 `npx wrangler deploy` 发布 API Worker `biff-scheduler`(公开入口;
     非 `/api/*` 请求由它经 `WEB` service binding 转发给前端 Worker)。
- **禁止** `wrangler pages deploy`(旧 Pages 已不在访问链路);**也禁止**拿 `npm run deploy` 当常规路径
  (它是 `build → 迁移 → web → api` 的手动兜底,只在 Cloudflare 侧不可用时才用)。
- 生效域名是 `https://biff.lcandy.co`;`biff.iff.day` 已进 `APP_ORIGIN` 白名单与账号系统回调登记,
  但**自定义域名尚未挂到 Worker 上**(该子域无 DNS 解析),需人工在 CF 控制台挂载,详见 `docs/account-integration.md`。
- 线上核对带 cache-buster;最强判据 = **asset hash 相同**(不是内容 grep)+ 自己新增字符串 + 阴性对照。
- **用户约定:每次改动完成后必须重新部署,无需再问。**

## 7. 并行协作(多会话 / 多 agent 同工作区)

- **开工前先同步远端**(用户 2026-09-14 约定):先 `git fetch` 看远端是否领先,领先就 `git pull --rebase origin main`,
  冲突在**动手写代码之前**解决完;开发中途远端又有新提交,提交前再拉一次。
  理由:实测过「写完 + 跑完测试,推送时才发现远端被 PR 领先」—— 冲突发现得越晚,rebase 后整轮门禁都得重跑。
- 提交前 `git log -1` 比对 HEAD + 连续 **90 秒**无新写入再动手。
- **只提交自己的 hunk**;配方见 SKILL `parallel-agent-safe-commit`。
- 有他人在途改动时走**隔离 worktree**;**绝不** `git stash` / `checkout` 对方文件。

## 8. 红线(违反即返工)

1. **云端红了(Cloudflare 构建 / CI)还继续叠改动** —— 先修再往下做。2. 无 PLAN 直接动手。3. 修 bug 不带回归测试。4. 为测试变绿改实现。
5. 同一口径写第二份实现。6. 改 `biff.*` 结构不带迁移 / 不删旧 key。7. 未经登录就上传片单,或把片单写入共享 / 非本人云端位置。8. 对小时取模。
9. 动态拼 Tailwind 类名 / `text-[Npx]`。10. 未量化就引新依赖。11. 提交临时文件 / `dist/` / 密钥。
12. `wrangler pages deploy` 直传。13. `push --force` 到 `main`。14. 为「看效果」反复起 dev server。
15. 把流水账堆进 `PLAN.md`(应进 `docs/history/` 或本需求 PLAN)。

## 9. 与 AI 协作的约定(需求怎么提 / AI 交什么)

> §0–§8 管「AI 拿到需求后怎么做」;本节管**上游那一半** —— 需求怎么提、变更怎么记、交付物长什么样。
> 完整版(含范例与反模式)见 `docs/DEVELOPMENT-STANDARDS.md` §9。

**一句话原则:人只描述「症状 + 约束」,不指定实现;AI 先读代码把症状还原成机制,再给方案。**
一切产物落成**文件**(PLAN / 测试 / 注释),不留在对话里 —— 对话会丢,文件不会。

### 9.1 三档需求:怎么提 / AI 必须先交什么 / 收口证据

| 档位 | 人怎么说 | AI 必须先交 | 收口证据 |
|---|---|---|---|
| **普通功能 / bug** | 「<入口> 现在 <现象>,应该 <期望>;不要动 <范围>」+ 截图或原话 | PLAN(四节,见 §9.3)→ 代码 + 回归测试 | 单测计数 + 受影响 spec 全绿 |
| **大规模重构 / 跨视图改造** | 「<症状>」+「硬约束:不能影响 <X>」+「先出 PLAN 再实现」 | 现状(代码事实 + 行号,**禁止推测**)/「为什么当初这么设计」/ 形态取舍表(采纳 vs 否决 + 理由)/ 集成点清单(既有机制逐条怎么处理)/ 复用清单 / 明确不做 / 「零影响」的核对手段 | 单一开关 + 逐处守卫 + 逐 hunk 复核 |
| **推送 / 发布** | 不用提 —— 按 §2 / §6 默认执行 | 无(测试已在开发阶段跑完) | 测试计数 / asset hash |

> 大重构的启动动作 = **先打 checkpoint**(§4.6):全绿落点 → 再开重构;
> 与「单一开关保住旧路径」是同一目的的两层保险(一层能回退,一层能共存)。

### 9.2 五条话术纪律

1. **不指定实现。** 说「地图入口要像豆瓣那样紧贴地名」,不要说「把 `margin-left` 去掉」——
   后者会挡掉更好的解法,也会让 AI 停止读代码。
2. **说清「不能影响什么」。** 硬约束比需求本身更能防返工(范例:`PLAN-20260912002532` §6「PC 端零影响」)。
3. **需求变了改 PLAN 文件** —— 追加 `## 修订 N(日期,触发原因)` 段,不要只在对话里改。
4. **给 AI 反驳你诊断的空间。** 症状是你观察到的,**成因不是你诊断的**;AI 归因不同时应直接说并给证据
   (范例:「只改默认落点,抱怨会原样复发,所以必须 A+B 同轮交付」)。
5. **长期约定一次讲清,写进本文件**(范例:§6「每次改动完成后必须重新部署,无需再问」)——
   之后不再重复叮嘱,也避免 AI 每轮重新猜。

### 9.3 PLAN 模板(可直接复制)

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

### 9.4 交付物清单(缺一即返工)

- PLAN 文件(§9.3 模板);**需求变更 = 追加修订段**,不是新开 PLAN。
- 回归测试,且**先红后绿** —— 红的那次要把失败值贴出来。
- 验证证据(测试计数 / 断言汇总 / asset hash),不许说「应该没问题」。
- 「不做」清单 —— 没写「不做」等于范围无限。
- 回写文档:**新需求只写本需求 PLAN**;`PLAN.md` 只更新文档头一行「最后更新」(**§0 只减不增**);
  本文件 / `docs/CONVENTIONS.md`(口径变更)。
