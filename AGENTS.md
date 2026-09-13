# AGENTS.md — biff-scheduler 开发规范(强制)

> 本文件是仓库**受版本控制**的规范入口,对所有协作者与 AI 助手生效。
> 完整版(含示例与论证)见 [`docs/DEVELOPMENT-STANDARDS.md`](./docs/DEVELOPMENT-STANDARDS.md);
> 具体口径细节见 [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md);当前状态与决策见 [`PLAN.md`](./PLAN.md)。
> 三者冲突时以 `docs/DEVELOPMENT-STANDARDS.md` 为准。
> 本机 CodeBuddy 另有一份自动加载副本:`.codebuddy/rules/biff-development-standards/RULE.mdc`(该目录被 gitignore,需手动同步)。

## 0. 总纲

**先 PLAN → 后实现 → 写测试 → 再推送。**
本仓库**没有 CI 兜底**:`git push origin main` 直接触发 Cloudflare Workers Builds 上线 `https://biff.lcandy.co`,
所以**测试必须在开发阶段跑完**;`push` 是纯发布动作,推的时候直接推。

## 1. 五步工作流(不可跳步)

1. **写 PLAN**:`docs/plans/PLAN-<YYYYMMDDHHMMSS>.md`,必含 目标 / 范围(含「不做什么」)/ 方案取舍 / 验收标准。
   需求变了改 PLAN 文件,不要只在对话里改。**只读本需求的 PLAN,不整读 `PLAN.md` 活文档。**
2. **实现**:代码 + 同步单测 / E2E。
3. **验证**:跑测试(单测 + 受影响 spec 的 E2E),见 §2。
4. **提交推送**:Conventional Commits → **直接推**,见 §4。
5. **回写文档**:`PLAN.md` §0/§6/§7;口径变更同步 `docs/CONVENTIONS.md`。

## 2. 验证与推送(红线:没跑过测试禁止 push)

> **原则**:测试是**开发阶段**的事,跑一次就够;`git push` 是纯发布动作,**推的时候直接推**,不在推送时重跑。

| 时机 | 做什么 | 命令 |
|---|---|---|
| 改完 / 开发中 | 跑与改动相关的测试 | 单测 `npm test`;改了 UI → 受影响 spec + 单浏览器 |
| 收尾(该需求最后一次) | 跑一次完整门禁 | `npm run verify`(= typecheck → lint → 单测 → vite build,1–3 min) |
| 大范围 / 发布前 | 全量三浏览器体检 | `npm run verify:full`(5–9 min) |
| **push** | **直接推,不重跑** | `git push origin main` |

**关于 `vite build`**:它只用于验证「能打包」——本地产物不会被部署(Cloudflare 云端会重新构建,`dist/` 也在 gitignore 里)。
所以**不是每次改动的必跑项**:日常跑 `npm test` + 受影响 spec 即可,build 放到收尾 / 推送前跑一次,用来提前发现打包错误。
`typecheck` / `lint` / 单测才是每次必过。

**「推的时候直接推」成立的前提:测试通过 → push 之间代码必须冻结。**
跑完测试后又改了任何文件,那次测试即失效,必须重跑 —— 否则等于没测。

- 测试失败先定位再改,禁止「重跑一次看运气」;验证结果必须**贴出证据**(测试计数 / 断言汇总)。
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

## 5. 代码规范

- **口径单一来源**:片名 / 日期 / 场次行 / 卡片头 / 转场余量 / GV 时长 / 有效结束时间 / 颜色 token 只允许一处实现。
  新增视图复用既有构造器(`row.ts` / `util.ts` / `ui.ts` / `chips.ts`),不要另写骨架。
- **数据契约**:`biff.*` key 只增不改;改结构必须「新 key + 一次性迁移 + 删旧 key」。**片单只存本地,不得回写云端。**
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

- 唯一常规路径:`git push origin main` → Workers Builds 自动上线。**禁止** `wrangler pages deploy`。
- 线上核对带 cache-buster;最强判据 = **asset hash 相同**(不是内容 grep)+ 自己新增字符串 + 阴性对照。
- **用户约定:每次改动完成后必须重新部署,无需再问。**

## 7. 并行协作(多会话 / 多 agent 同工作区)

- 提交前 `git log -1` 比对 HEAD + 连续 **90 秒**无新写入再动手。
- **只提交自己的 hunk**;配方见 SKILL `parallel-agent-safe-commit`。
- 有他人在途改动时走**隔离 worktree**;**绝不** `git stash` / `checkout` 对方文件。

## 8. 红线(违反即返工)

1. 没跑过测试就 push;或测试通过后又改了代码,不重跑就 push。2. 无 PLAN 直接动手。3. 修 bug 不带回归测试。4. 为测试变绿改实现。
5. 同一口径写第二份实现。6. 改 `biff.*` 结构不带迁移 / 不删旧 key。7. 把用户片单写回云端。8. 对小时取模。
9. 动态拼 Tailwind 类名 / `text-[Npx]`。10. 未量化就引新依赖。11. 提交临时文件 / `dist/` / 密钥。
12. `wrangler pages deploy` 直传。13. `push --force` 到 `main`。14. 为「看效果」反复起 dev server。
15. 把流水账堆进 `PLAN.md`(应进 `docs/history/` 或本需求 PLAN)。
