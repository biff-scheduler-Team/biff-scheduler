# AGENTS.md — biff-scheduler 开发规范(强制)

> 本文件是仓库**受版本控制**的规范入口,对所有协作者与 AI 助手生效。
> 完整版(含示例与论证)见 [`docs/DEVELOPMENT-STANDARDS.md`](./docs/DEVELOPMENT-STANDARDS.md);
> 具体口径细节见 [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md);当前状态与决策见 [`PLAN.md`](./PLAN.md)。
> 三者冲突时以 `docs/DEVELOPMENT-STANDARDS.md` 为准。
> 本机 CodeBuddy 另有一份自动加载副本:`.codebuddy/rules/biff-development-standards/RULE.mdc`(该目录被 gitignore,需手动同步)。

## 0. 总纲

**先 PLAN → 后实现 → 写测试 → 再推送。**
`git push origin main` 直接触发 Cloudflare Workers Builds,云端跑的构建命令就是 `npm run build`
(= typecheck → lint → 单测 → 各 workspace 构建),**失败即不上线**;但云端失败**不会回滚已推送的提交**,
只会把部署卡在那里 —— 所以**测试仍然必须在开发阶段跑完**,`push` 保持纯发布动作,推的时候直接推。

## 1. 五步工作流(不可跳步)

1. **写 PLAN**:`docs/plans/PLAN-<YYYYMMDDHHMMSS>.md`,必含 目标 / 范围(含「不做什么」)/ 方案取舍 / 验收标准
   (模板见 §9.3)。需求变了改 PLAN 文件,不要只在对话里改。**只读本需求的 PLAN,不整读 `PLAN.md` 活文档。**
   需求**怎么提**、AI **必须交什么**见 §9。
2. **实现**:代码 + 同步单测 / E2E。
3. **验证**:跑测试(单测 + 受影响 spec 的 E2E),见 §2。
4. **提交推送**:Conventional Commits → **直接推**,见 §4。
5. **回写文档**:`PLAN.md` §0/§6/§7;口径变更同步 `docs/CONVENTIONS.md`。

## 2. 验证与推送(红线:没跑过测试禁止 push)

> **原则**:测试是**开发阶段**的事,跑一次就够;`git push` 是纯发布动作,**推的时候直接推**,不在推送时重跑。

| 时机 | 做什么 | 命令 |
|---|---|---|
| 改完 / 开发中 | 跑与改动相关的测试 | 单测 `npm test`;改了 UI → `npm run verify:ui -- <spec> --project=desktop-chromium` |
| 收尾(该需求最后一次) | 跑一次完整门禁 | `npm run verify`(= typecheck → lint → 单测 → vite build,1–3 min) |
| 大范围 / 发布前 | 全量三浏览器体检 | `npm run verify:full`(5–9 min) |
| **push** | **直接推,不重跑** | `git push origin main` |

**关于 `vite build`**:它只用于验证「能打包」——本地产物不会被部署(Cloudflare 云端会重新构建,`dist/` 也在 gitignore 里)。
所以**不是每次改动的必跑项**:日常跑 `npm test` + 受影响 spec 即可,build 放到收尾 / 推送前跑一次,用来提前发现打包错误。
`typecheck` / `lint` / 单测才是每次必过。

**`verify:ui` = 一次 build 两用,不要拆成两条命令**:E2E 的 `webServer` 跑 `vite preview`,吃的是 `dist/`,
所以 E2E 之前必须 build;而 `npm run verify` 里已经 build 过一次 —— 先 `verify` 再 `test:e2e:react` 就是 build 两次。
改了 UI 直接跑 `npm run verify:ui -- <spec> --project=<project>`(参数透传给 playwright),
它 = typecheck + lint + 单测 + build web + 指定 spec,已经覆盖门禁;**不要**再补一次 `verify`
(除非本轮还动到了 `apps/api`,需要验证 worker 打包)。小范围 bugfix 不要上 `verify:full`(5–9 min 三浏览器)。

**「推的时候直接推」成立的前提:测试通过 → push 之间代码必须冻结。**
跑完测试后又改了任何文件,那次测试即失效,必须重跑 —— 否则等于没测。

- 测试失败先定位再改,禁止「重跑一次看运气」;验证结果必须**贴出证据**(测试计数 / 断言汇总)。
- **「受影响 spec」有表可查**:`docs/TEST-MAP.md`(机读源 `scripts/test-map.json`)。
  `npm run specs:affected` 按当前 diff 输出必跑 spec —— 不要再凭印象挑。
- **CI 兜底**:`.github/workflows/ci.yml`。PR 跑 `verify:quick` + 受影响 spec(单浏览器);
  `main` push 跑全量三浏览器。CI 不改变本地门禁的职责划分(测试仍在开发阶段跑完),
  它只负责挡住「人漏了」这一种情况。
- **排查 E2E 失败只跑单文件 + 单浏览器**;全量三浏览器只在确认修复后跑**一次**,不要拿全量重跑做二分。
- E2E 跑完若 `31029` 端口仍被占用,说明 `webServer` 未优雅退出 —— 修配置,不要把 `kill -9` 当常规手段。
- 改了 `tools/*.py` → 跑一遍脚本自检,输出须与基线一致或显式说明差异。
- 改了 `apps/web/public/*.json` → 跑 `npm run verify`,产物必须能正常加载。

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

## 5. 代码规范

- **口径单一来源**:片名 / 日期 / 场次行 / 卡片头 / 转场余量 / GV 时长 / 有效结束时间 / 颜色 token 只允许一处实现。
  新增视图复用既有构造器(`row.ts` / `util.ts` / `ui.ts` / `chips.ts`),不要另写骨架。
- **数据契约**:`biff.*` key 只增不改;改结构必须「新 key + 一次性迁移 + 删旧 key」。
  **片单默认只存本地**;仅当用户**主动登录 IFFDAY** 后,才同步到 `festival_document` 里**该账号自己
  (`subject` 隔离)**的那一份 —— **不得未经登录就上传,不得写入任何共享 / 非本人位置**;
  账号相关的 localStorage 键走 `iffday.workspace.*` 命名空间,**不占 `biff.*`**。
- **24+ 时制**:午夜场 `"29:35"` = 次日 05:35,**不得对小时取模**;唯一归一化闸门 `data.ts::loadCatalog()`。
- **依赖**:引入前量化 gzip 增量 + 实际调用点,成本 > 收益即否决。
- **Tailwind v4**:token 是唯一色源;字阶 / 圆角走 `text-12` / `rounded-8`,禁止 `text-[Npx]` 任意值;
  只写字面量类名(禁止拼 `bg-${p}`);`@utility` 权重低于 `hover:`,JS 状态类需 `!important`;暗色只覆盖 token。
- **React**:受控 / 无状态优先,禁止组件内藏状态副本;弹层 `role=dialog` + focus trap + 焦点归还;
  断点 768 / 1099 / 720 的 JS 与 CSS 值逐字一致;「常态淡显 hover 显现」的控件挂 `ui-icon-btn`。
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

- 提交前 `git log -1` 比对 HEAD + 连续 **90 秒**无新写入再动手。
- **只提交自己的 hunk**;配方见 SKILL `parallel-agent-safe-commit`。
- 有他人在途改动时走**隔离 worktree**;**绝不** `git stash` / `checkout` 对方文件。

## 8. 红线(违反即返工)

1. 没跑过测试就 push;或测试通过后又改了代码,不重跑就 push。2. 无 PLAN 直接动手。3. 修 bug 不带回归测试。4. 为测试变绿改实现。
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
- 回写 `PLAN.md` §0(状态)+ 本文件 / `docs/CONVENTIONS.md`(口径变更)。
