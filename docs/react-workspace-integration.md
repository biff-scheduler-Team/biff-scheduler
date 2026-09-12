# React 前端回迁

2026-09-13 将 `codex/react-router-spectrum` 整合回 `main`。

整合前检查点：原目录 `4feda07`（原目录无未提交改动，记录空检查点）；新版 worktree `14c29b1`。

- 新版源代码、静态入口和 legacy 入口位于 `apps/web`，保持 npm workspaces 结构。
- `apps/api`、`packages/contracts`、D1/Drizzle 和部署配置保留原目录版本。
- 保留账号服务及同步算法；账号表单接入 Spectrum Dialog，前端状态写入继续发出账号同步通知。
- 原有 `biff.*` 数据结构不变；旧版在 `/legacy/` 独立运行。
- 新版测试在 `e2e/react`，使用 `playwright.react.config.ts`；原账号全链路测试保留原配置。

验证：根目录完整 build 通过，包含 212 项单元测试、前端产物和 API dry-run 构建。36 项整合 E2E 通过，覆盖三种浏览器配置下的新版主要交互，以及使用模拟 API 的访客数据保留、账号资料编辑和自动排片同步。此次未启动外部 IFFDAY 身份服务的真实登录全链路，也未部署或推送。
