# AGENTS.md — biff-scheduler 开发规范(强制)

> 本文件是仓库**受版本控制**的规范入口,对所有协作者与 AI 助手生效。
> 完整版(含示例与论证)见 [`docs/DEVELOPMENT-STANDARDS.md`](./docs/DEVELOPMENT-STANDARDS.md);
> 具体口径细节见 [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md);当前状态与决策见 [`PLAN.md`](./PLAN.md)。
> 三者冲突时以 `docs/DEVELOPMENT-STANDARDS.md` 为准。
> **规范只有这一份。** `.codebuddy/rules/biff-development-standards/RULE.mdc` 自 2026-10-16 起只是
> 一个**指针**(保留 `alwaysApply` 让它把注意力指回本文件),**不再复制条文** —— 双份规范必然漂移,
> 每次改口径还要改两遍。「只对本机成立」的约定落 `.scratch/local-conventions.md`(gitignore,非规范)。

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
   ⚠ **免 PLAN 档(2026-10-16 增)**:下面这几类**不写 PLAN**,直接在 commit body 写三行
   (改了什么 / 为什么 / 怎么验)即可 ——
   · **数据产物**(`*.json`:海报、场次、排期数据,含 `apps/web/public/*.json` / `data/*.json`);
   · **纯文案**(用户可见文字的字面量增删改,不动逻辑);
   · **纯样式值**(颜色 / 字号 / 间距 token 的取值调整,不动结构与类名);
   · **单文件且 diff < 20 行**(含注释、文档)。
   依据:实测 231 份 PLAN / 37 天、平均 78 行,而其中相当一部分提交是「改一个半径值」「补一张海报」
   这种一行改动 —— 给一行改动写 78 行 PLAN 是纯开销,还会让**真正需要 PLAN 的改动**被稀释。
   ⚠ 豁免的**只是 PLAN**;**测试 / 回归用例 / 验证证据照旧**(§3 / §9.4)。
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
| **GitHub CI**(`.github/workflows/ci.yml`) | push `main`:`check:ci` + 全量三浏览器 E2E;PR:`check:ci` + **PR 专用** typecheck/lint/单测 + 受影响 spec | **PR 门禁 + 事后体检**,不回滚 |

> ⚠ **2026-10-16 去重**:`main` 上 CI **不再重跑 typecheck / lint / 单测** —— 同一批命令 Workers Builds
> 已在**部署前**跑过,再跑一遍零信息增量,只是让你多等一轮 job。CI 只留 CF 不跑的两样
> (`check:repo` / `check:test-map`)。PR 分支没有「部署前门禁」兜底,所以 PR 上仍由 CI 自己跑那三样。
>
> ⚠ **2026-10-16 实测(别再拍脑袋估)**:① **push → 线上可见变化 ≈ 11.5 分钟**(`635a281` 于 16:40:56Z 推送、
> 16:52:27Z 写入构建身份);② **全量三浏览器 E2E 绿 5–9 min,红 27–29 min** ——
> 差距来自 `retries: 1`(失败用例跑两遍)与失败时的 trace / 截图上传。所以「27 分钟」是**红的症状**,
> 不是配置坏了;③ CI 门禁去重只省 **20 秒**(它从来不是瓶颈 —— 别再拿它当选型理由)。
> ⚠ **`--sha HEAD` 在多会话共用工作区会被带偏**:它取的是**当前** HEAD,而并行会话随时在你之上提交
> (实测踩到:自己那笔已上线,却一直判失败)。核对时**钉死你 push 的那笔 sha**。
>
> ⚠ **E2E 只跳过「一定不可能影响 UI」的提交**:`ci.yml` 在 `main` 上按 `git diff HEAD^ HEAD` 判断,
> 改动不含 `apps/` 且不含 `packages/` 时整条 e2e job 不启动。**这是唯一允许的瘦身** ——
> 把浏览器档从三降到一(chromium-only)会让 `mobile-webkit` 的红永久隐身,**不做**(见 §8 红线 1 新增的第二句)。
>
> ⚠ **main 红的负责机制(2026-10-16 新增)**:`main` 红了 = **谁的提交谁负责修**;发现者把 run 链接贴出来,
> 作者在**当天**给出修复或明确「已知、暂缓 + 为什么」。不许既不修也不说 —— 2026-10-15 全天的红
> (6 个 spec、跨三个浏览器)就是这样一路红到晚上的。

| 时机 | 做什么 | 命令 |
|---|---|---|
| 日常改完 | **什么都不用跑**,直接提交 push | — |
| 想 push 前先知道结果 | 跑一次快速门禁 | `npm run verify:quick` |
| 改了 UI 且自己没底 | 单 spec 桌面端 | `npm run verify:ui -- e2e/react/<spec>.spec.ts --project=desktop-chromium` |
| 只是**想看真实效果** | **推 `main` 后在真站上看**(常规路径,CF 构建失败即不上线) | `git push origin main` |
| UI 大改、光看真站不够 | 起**一次** dev server,看完即停(**不要每轮重启**) | `npm run dev` |
| 排查 CI 上的 E2E 失败 | **先单文件 + 单浏览器**,不要拿全量重跑做二分 | `npx playwright test -c playwright.react.config.ts e2e/react/<spec>.spec.ts --project=desktop-chromium` |

- `verify` / `verify:ui` / `verify:full` 仍是**按需可用**的工具(没有删),只是不再「必跑」。
- **要跑就只跑一条**:`verify:ui` = typecheck + lint + 单测 + `build -w @biff/web` + 指定 spec,
  不要再补 `npm run verify`(除非本轮动到了 `apps/api`,需要验证 worker 打包);
  `verify:full`(5–9 min 三浏览器)只在**确认修复后**跑一次。
- `check:repo` / `check:test-map` 仍在 `verify:quick` 里(单独跑用 `npm run check:ci`),CI 的 gate 也跑它们
  —— 本地不跑就会被 CI 挡。`verify:quick` = `check:ci` + `verify:code`(`typecheck` + `lint` + 单测)。
- **「受影响 spec」有表可查**:`docs/TEST-MAP.md`(机读源 `scripts/test-map.json`)。
  ⚠ `npm run specs:affected` 无参数时按 `origin/main...HEAD`(已提交差异)算,未提交的改动要用 `--files <path>`。
- **CI / Cloudflare 红了先修再叠改动**(§8 红线 1);报告结果要**贴证据**(CI 链接 / 测试计数),别说「应该没问题」。
- 若选择本地跑,则「测试通过 → push 之间代码必须冻结」—— 跑完又改了任何文件,那次结果即失效。
- **交付口径**:§6 部署核对(构建 SHA 相同 + asset hash + 自增字符串 + 阴性对照)完成,**即视为上线成功**。
  核对方式 = 一条命令:`npm run verify:deploy -- --sha HEAD --new "<本轮新增的字符串>"`;
  它输出**一行**可直接贴进报告的结论(`✓ 上线已核实 —— … · 构建 SHA xxx / 期望 xxx · 新字符串 1/1 命中 · 阴性对照 1/1 未命中`),
  失败给 `exit 1` 并逐条列原因。**`--sha HEAD` 是最强也最必要的一条** —— 它是唯一能回答
  「**这次提交上线了吗**」的判据(asset hash 只在应用产物变化时才变,纯文档提交的 hash 与上一版逐字相同)。
  纯文档 / 工具链改动没有新字符串可传,只给 `--sha HEAD` 即可;一条判据都不给则 `exit 2`。
  `main` 上的全量 E2E 是**非阻塞的事后体检** —— 交付时**不写「等 CI 跑完」**(那会让人误以为它是瓶颈),
  正确写法是「部署已核实(贴证据);`main` 全量 E2E 仍在跑,**非阻塞**」。它红了按 §8 红线 1 **优先修**,
  但**不回滚**已上线版本、也**不改变**本次交付结论(完整版见 `DEVELOPMENT-STANDARDS.md` §2.4)。

## 3. 测试要求

- **每个 bug 修复必须带一条能复现原 bug 的回归测试**(先红后绿)。
- 断言写「当前实际行为」;实现与注释相左时在注释里记明分歧,**不得为让测试变绿去改实现**。
- 纯逻辑模块 import 期禁止碰 DOM;E2E 用 DOM 计数 / class token / `:text-is()`,不靠截图。
- 写交互验收前读 SKILL `web-ui-headless-interaction-qa`。

## 4. 提交规范

`<type>(<scope>): <中文一句话描述>`,`type` ∈ `feat` `fix` `refactor` `perf` `style` `docs` `test` `chore` `data` `build`。

- **提交前必过 code review Skill(用户约定)**:每次 `git commit` 之前必须调用 SKILL `code-review-skill`
  审查本轮改动(`git diff` / `git diff --staged`),按结论**修完再提交**;不得跳过,也不得「先提交再补 review」。
  **终止条件**:同一提交内最多两轮(第 1 轮全量 → 第 2 轮只审修复产生的增量),第 2 轮仍有问题就**停下来问人**,不递归。
  **自指豁免**:改动本身就是 code review 规则 / 这个 SKILL 时,只做一次静态一致性检查,不递归(完整版见 `DEVELOPMENT-STANDARDS.md` §4.7.1)。
  **免审档(2026-10-16 增)**:diff **只含**下面几类时**跳过** `code-review-skill` ——
  ① **数据产物**(`*.json` 的字面量增删改);② **纯文案**;③ **纯样式 token 取值**;④ **`*.md` 与代码注释**。
  理由:review 的清单(代码质量 / 安全 / 性能 / 架构)针对的是**可执行逻辑**,这四类无从着手 ——
  跑了也只是把同一份 diff 再读一遍,而每轮的成本是一次完整的 skill 调用。
  ⚠ 判据是「**只含**」:同一提交里只要夹进一行逻辑改动,整份 diff 就得走完整 review。
  ⚠ **它与 §1 的免 PLAN 档不是同一张名单**:「单文件且 diff < 20 行」**免 PLAN 但免不了 review** ——
  20 行完全可能是一处逻辑改动。两张名单的关系是:免审档 ⊆ 免 PLAN 档(数据 / 文案 / 样式值两边都免)。
- 一次提交只做一件事;body 写「为什么 + 验证结果」。
- 禁止:提交临时文件 / `dist/` / `data/_cache/` / 密钥;`push --force` 到 `main`;amend 已推送提交;`--no-verify`;把他人改动搭车提交。
- **会话草稿不落仓库根**:一律落 `.scratch/`(已 gitignore)。落点必须**工具中立** ——
  不得指定 `.codebuddy/` / `.workbuddy/` 这类单个 IDE 的目录,同事可能用别的助手。
  根目录是**白名单制**,由 `npm run check:repo`(`scripts/check-repo.mjs`,已串进 `verify:quick` / `verify`)机械拦截。
- **钩子(机械约束)**:`npm install` 会自动装(`prepare` → `scripts/install-git-hooks.mjs`,手动重装 `npm run hooks:install`)。
  只留 `commit-msg`(校验本节格式,即时);**`pre-push` 已于 2026-09-16 删除** —— 它原来跑的 `verify:quick`
  在 Cloudflare 构建里**部署前**已经跑过一遍(§2),本地再跑只是让每次 push 多等 40 秒。
  安装脚本会连带**清理已下线的托管钩子**(只碰它自己装过的名字)。
- **哪些改动走 PR**(完整版见 `DEVELOPMENT-STANDARDS.md` §4.5;2026-10-16 **再收一档**):
  **只保留四类** —— ① 大规模重构 / 跨视图改造(§9.1 第二档);② 涉及 `apps/api`;
  ③ **D1 迁移**;④ **依赖升级**。**其余一律直接 push `main`**。
  ⚠ 与旧口径的差别:此前「命中 `allOn` 全量」或「有业务 spec 覆盖」也要走 PR,现已取消 ——
  因为 `main` 上的全量 E2E 本来就是**非阻塞的事后体检**(§2 交付口径),PR 在这里买不到额外保障,
  只付出分支 / rebase / 等合并这些摩擦。受影响 spec 仍可**本地按需跑**(§2 时机表),
  它有表可查(`docs/TEST-MAP.md`,机读源 `scripts/test-map.json`)。
  ⚠ PR 买到的仍然只是「受影响 spec 在**合并前**跑(Review 记录 + Verified 签名)」——
  **不等于「合并前跑过全量」**,也不能让全量在部署前跑完(§2)。
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
     时执行生产 D1 迁移 `db:migrate:remote`,然后**先部署 API Worker、再部署前端 Worker**
     `biff-scheduler-web`;本地构建与预览分支**不迁移、不部署**;
     ⚠ **API 先于 web 是硬要求**(2026-10-05,PLAN-20261005182415 修订 5):载荷契约向前兼容的方向是
     「新 API 认旧前端」,反过来(新前端打到旧 API)会 422。顺序反了就有几分钟窗口出这种 422;
  3. 最后由仓库原有的 `npx wrangler deploy` 再发布一次 API Worker `biff-scheduler`(公开入口;
     非 `/api/*` 请求由它经 `WEB` service binding 转发给前端 Worker)。第 2 步已经部署过它,
     这一步是同一份代码的幂等重发 —— 保留是为了不动 CI 侧那条既有命令。
- **禁止** `wrangler pages deploy`(旧 Pages 已不在访问链路);**也禁止**拿 `npm run deploy` 当常规路径
  (它是 `build → 迁移 → api → web` 的手动兜底,只在 Cloudflare 侧不可用时才用)。
- 生效域名是 `https://biff.lcandy.co`;`biff.iff.day` 已进 `APP_ORIGIN` 白名单与账号系统回调登记,
  但**自定义域名尚未挂到 Worker 上**(该子域无 DNS 解析),需人工在 CF 控制台挂载,详见 `docs/account-integration.md`。
- 线上核对:**一条命令** ——
  `npm run verify:deploy -- --sha HEAD [--new "<本轮新增的字符串>" --negative "<本轮删掉的字符串>"]`,
  即带 cache-buster 拉 `https://biff.lcandy.co/`,比对**构建 SHA**(最强) + asset hash + grep 新字符串
  + 跑阴性对照,输出一行结论。判据强度与实现见 `scripts/verify-deploy.mjs` 文件头。
  - **构建 SHA 从哪来**:`scripts/prepare-cloudflare.mjs` 在 build 后把
    `{ sha, branch, builtAt }` 写进 `apps/web/dist/version.json`(dist 已在 gitignore,不污染工作树)。
    在此之前「这次提交上线了吗」**没有可观测证据** —— 线上区分不了「构建成功但产物相同」与「构建失败没发布」。
- **预览环境(2026-10-16)**:非 `main` 分支可以拿到**可看的预览 URL**,不必为了「看一眼」推生产。
  前提两条:① `apps/web/wrangler.jsonc` 的 `preview_urls: true`(仓库侧已开;API Worker 没开,也不需要
  —— 预览看的是前端产物);② **Cloudflare 控制台**里开着「Builds for non-production branches」(仓库改不了)。
  `prepare-cloudflare.mjs` 对预览分支**不迁移、不部署生产**,只会打一行说明。
- ⚠ **待控制台改的一条(2026-10-16)**:仓库 `package.json` 构建后,Workers Builds 还会再跑一遍
  **根目录 `npx wrangler deploy`** —— 而 `prepare-cloudflare.mjs` 已经部署过同一个 API Worker(第 2 步)。
  这是**同一个 Worker 的重复上传**。删掉它需要把控制台里的构建命令从
  `… && npx wrangler deploy` 改成只留 `npm run build`(仓库里的 `.wrangler/deploy/config.json` 就是为那条命令生成的,
  删掉命令后它可以一并清理)。**仓库侧改不了,别在代码里瞎猜。**
- **用户约定:每次改动完成后必须重新部署,无需再问。**

## 7. 并行协作(多会话 / 多 agent 同工作区)

- **开工前先同步远端**(用户 2026-09-14 约定):先 `git fetch` 看远端是否领先,领先就 `git pull --rebase origin main`,
  冲突在**动手写代码之前**解决完;开发中途远端又有新提交,提交前再拉一次。
  理由:实测过「写完 + 跑完测试,推送时才发现远端被 PR 领先」—— 冲突发现得越晚,rebase 后整轮门禁都得重跑。
- 提交前 `git log -1` 比对 HEAD + 连续 **90 秒**无新写入再动手。
- **只提交自己的 hunk**;配方见 SKILL `parallel-agent-safe-commit`。
- 有他人在途改动时走**隔离 worktree**;**绝不** `git stash` / `checkout` 对方文件。

## 8. 红线(违反即返工)

1. **云端红了(Cloudflare 构建 / CI)还继续叠改动** —— 先修再往下做。**红了既不修也不说同样违规**
   (§2 负责机制:谁的提交谁修,当天给出修复或明确「已知、暂缓 + 为什么」)。2. 无 PLAN 直接动手(除 §1 的**免 PLAN 档**)。3. 修 bug 不带回归测试。4. 为测试变绿改实现。
5. 同一口径写第二份实现。6. 改 `biff.*` 结构不带迁移 / 不删旧 key。7. 未经登录就上传片单,或把片单写入共享 / 非本人云端位置。8. 对小时取模。
9. 动态拼 Tailwind 类名 / `text-[Npx]`。10. 未量化就引新依赖。11. 提交临时文件 / `dist/` / 密钥。
12. `wrangler pages deploy` 直传。13. `push --force` 到 `main`。
14. 为「看效果」**反复重启** dev server(同一轮一次即可 —— 常规路径是推 `main` 在真站上看,§2)。
15. 把流水账堆进 `PLAN.md`(应进 `docs/history/` 或本需求 PLAN)。
16. 为提速把全量 E2E 的浏览器档**从三降到一**(chromium-only)—— 那会让 `mobile-webkit` 的红永久隐身
    (§2 只允许一种瘦身:按 diff 跳过不含 `apps/` 与 `packages/` 的提交)。

## 9. 与 AI 协作的约定(需求怎么提 / AI 交什么)

> §0–§8 管「AI 拿到需求后怎么做」;本节管**上游那一半** —— 需求怎么提、变更怎么记、交付物长什么样。
> 完整版(含范例与反模式)见 `docs/DEVELOPMENT-STANDARDS.md` §9。

**一句话原则:人只描述「症状 + 约束」,不指定实现;AI 先读代码把症状还原成机制,再给方案。**
一切产物落成**文件**(PLAN / 测试 / 注释),不留在对话里 —— 对话会丢,文件不会。

### 9.1 三档需求:怎么提 / AI 必须先交什么 / 收口证据

| 档位 | 人怎么说 | AI 必须先交 | 收口证据 |
|---|---|---|---|
| **微小改动 / 免 PLAN 档**(§1) | 直接说改哪儿 | **不写 PLAN** —— commit body 三行(改了什么 / 为什么 / 怎么验) | commit body 里的验证结果 |
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

- PLAN 文件(§9.3 模板);**需求变更 = 追加修订段**,不是新开 PLAN —— **免 PLAN 档除外**(§1)。
- 回归测试,且**先红后绿** —— 红的那次要把失败值贴出来。
- 验证证据(测试计数 / 断言汇总 / asset hash),不许说「应该没问题」。
- 「不做」清单 —— 没写「不做」等于范围无限。
- 回写文档:**新需求只写本需求 PLAN**;`PLAN.md` 只更新文档头一行「最后更新」(**§0 只减不增**);
  本文件 / `docs/CONVENTIONS.md`(口径变更)。
