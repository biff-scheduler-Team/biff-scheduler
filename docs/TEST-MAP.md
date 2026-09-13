# TEST-MAP — 改动路径 → 必跑 spec

> 2026-09-13 立(`PLAN-20260913201727`)。
> §2 要求「改了 UI → 跑受影响 spec」,但 `e2e/react/` 有 31 个 spec,「受影响」以前只存在于人脑里 ——
> 于是要么漏跑,要么每次全量(5–9 min)。本表把它变成可执行的映射。

## 怎么用

```sh
# 我改了几个文件,该跑哪些 spec?
node scripts/affected-specs.mjs --files apps/web/src/pages/AgendaPage.tsx

# 相对某个 ref 的改动(CI 用这个)
node scripts/affected-specs.mjs --base origin/main

# 真去跑(单浏览器,排查阶段用)
npx playwright test -c playwright.react.config.ts \
  $(node scripts/affected-specs.mjs --base origin/main) --project=desktop-chromium
```

输出是**最少必跑集**,不是「跑了这些就一定够」。命中 `allOn` 或无法归类时返回全量。

## 映射表

<!-- 下面这一块由 `node scripts/affected-specs.mjs --write-doc` 生成,不要手改 -->
<!-- BEGIN GENERATED:test-map -->
| 改动路径(前缀) | 必跑 spec |
|---|---|
| `apps/web/src/pages/SchedulePage.tsx`<br>`apps/web/src/pages/schedule-parity.css`<br>`apps/web/src/grid.ts` | `parity-schedule` · `vertical-schedule` · `time-axis` · `night-axis` · `schedule-size` · `schedule-toolbar` · `combined-screenings` · `badge-tooltip` |
| `apps/web/src/pages/AgendaPage.tsx`<br>`apps/web/src/pages/agenda-parity.css`<br>`apps/web/src/plans.ts`<br>`apps/web/src/timeline.ts` | `parity-agenda` · `review-schedule` · `combined-screenings` |
| `apps/web/src/pages/LibraryPage.tsx` | `parity-library` · `review-library` · `screening-popover` · `want-counts` |
| `apps/web/src/pages/FilmDialog.tsx` | `parity-dialogs` · `screening-popover` · `want-counts` |
| `apps/web/src/components/ScreeningCard.tsx`<br>`apps/web/src/components/ScreeningInfoPopover.tsx`<br>`apps/web/src/components/ScreeningMemberList.tsx` | `parity-agenda` · `parity-library` · `screening-popover` · `gv-popover` · `combined-screenings` |
| `apps/web/src/components/ExportDialog.tsx`<br>`apps/web/src/components/SettingsDialog.tsx`<br>`apps/web/src/components/InfoDialogs.tsx`<br>`apps/web/src/components/FilterBar.tsx` | `review-state-export` · `review-shared` · `workflows` · `parity-dialogs` |
| `apps/web/src/account.ts`<br>`apps/web/src/account-sync.ts`<br>`apps/web/src/sync-data.ts`<br>`apps/web/src/workspace-storage.ts`<br>`apps/web/src/components/AccountHost.tsx`<br>`apps/web/src/components/account-ui.css`<br>`apps/api/`<br>`packages/contracts/`<br>`apps/web/legacy/src/account-bridge.ts`<br>`apps/web/legacy/src/state.ts`<br>`apps/web/legacy/src/main.ts`<br>`apps/web/legacy/index.html` | `account-integration` · `legacy` |
| `apps/web/src/app/`<br>`apps/web/src/main.tsx` | `persistent-header` · `floating-panel` · `desktop` · `edge-cases` |
| `apps/web/src/state.ts`<br>`apps/web/src/backup.ts`<br>`apps/web/src/ics.ts`<br>`apps/web/src/share.ts` | `review-state-export` · `workflows` · `legacy` · `compatibility` |
| `apps/web/public/manifest.webmanifest` | `offline` |
| `apps/api/src/want-stats.ts`<br>`apps/api/src/want-store.ts`<br>`apps/web/src/want-counts.ts`<br>`apps/api/migrations/0003_film_want_stat.sql` | `want-counts` |
| **任何改动都跑** | `smoke` |
| **命中即全量** | `apps/web/src/style.css` · `apps/web/index.html` · `package.json` · `package-lock.json` · `playwright.react.config.ts` · `tsconfig.tests.json` · `vitest.config.ts` · `apps/web/vite.config.ts` |
<!-- END GENERATED:test-map -->

## 维护约定

- **唯一来源是 `scripts/test-map.json`**。改完跑一次 `node scripts/affected-specs.mjs --write-doc`。
- `--check` 会断言本文件的表格与 JSON 同步,已串进 `npm run verify:quick` —— **手改表格会被门禁挡下**。
  这条是为了避免「同一口径两份实现」(§5.1):表格是 JSON 的**渲染**,不是它的副本。
- 新增 spec 文件后,记得把它挂进某条规则(或确认它本来就只属于 `always` / 全量)。

## 单测那边怎么对应

E2E 走上面的映射表;**单测不需要表** —— 它本来就是「一源一测」:

- `apps/web/src/<name>.ts` ↔ `apps/web/tests/<name>.test.ts`(改纯函数必须同步改同名测试,见 §2 / §3.2)。
- `apps/api/src/<name>.ts` ↔ `apps/api/tests/<name>.test.ts`。
  ⚠ **必须留在本 workspace**,不能搬进根 `tests/`:根 `tests/` 继承 `apps/web/tsconfig.json`(DOM lib),
  把 api 源码拉进那个程序会立刻报 `Uint8Array<ArrayBufferLike>` 不满足 `BufferSource`
  (原因写在 `apps/api/vitest.config.ts` 的注释里)。
- `packages/contracts/src/<name>.ts` 的单测跟着**调用方**走(`apps/api/tests/contracts.test.ts`)——
  它是 api 的序列化口径,不是 web 的。
- 改了 `apps/web/public/*.json` → 跑 `npm run verify`(产物必须能被 `data.ts` 正常加载)。
- 改了 `tools/*.py` → 跑脚本自检,输出须与基线一致或显式说明差异。

## 不在这张表里的

- `e2e/account.spec.ts`(`playwright.config.ts` 那一套):需要**真实 IFFDAY 账号服务**与 `IFFDAY_ACCOUNT_PATH`,
  **不在 CI 跑**;本地联调用 `npm run test:e2e`,方法与配置见 `docs/account-integration.md`。
- `npm run verify:full`(三浏览器全量):只在**发布前 / 大范围改动**时跑,不按 diff 挑。
