# Legacy(`/legacy/`)冻结与退役计划

> 2026-09-13 立(`PLAN-20260913201727`)。
> 现状:**冻结已经存在且已被机械执行** —— 缺的是「什么时候可以删」与「怎么删」。

## 一、现状(代码事实)

`apps/web/legacy/` 是 React 重写之前的原版界面,冻结在提交 **`8a95215`**,挂在 `/legacy/`。

| 项 | 事实 |
|---|---|
| 体量 | 39 个 TS 文件 + `index.html` + `modern-promotion.css`,**12598 行** |
| 构建 | `vite.config.ts` 的**第二个入口**(`legacy: ./legacy/index.html`)→ 每轮构建都产出 |
| 产物 | `dist/legacy/index.html` 20.06 kB · `dist/assets/legacy-*.js` **174.70 kB** · `legacy-*.css` 45.31 kB(均未 gzip) |
| 路由 | `/legacy` → 308 → `/legacy/`(dev 与 preview 中间件);新版 `App.tsx` 有 `version-link` 指向它 |
| 数据 | 同域同 `biff.*`,无需迁移;旧版有「体验新版」链接回 `/` |
| PWA | workbox 的 `manifestTransforms` 额外把 `legacy` / `legacy/` 塞进预缓存清单 |
| **冻结闸门** | `apps/web/tests/legacy-snapshot.test.ts` 逐文件比对 `legacy/source-manifest.json` 的 SHA-256(revision `8a952153`,38 个文件)—— **改 legacy 不改 manifest 就一定红** |
| 覆盖 | `e2e/react/legacy.spec.ts`(能打开 / 308 生效 / 与新版权共享数据)+ `compatibility.spec.ts`(存储键逐字节兼容) |

**它存在的理由**:新版出 P0 时,`/legacy/` 是**同域、同 localStorage 的逃生舱** —— 用户不用换域名、
不用导入导出,刷新即可回到能用的界面。删掉它等于把回退能力换成 `git revert` + 重新部署。

## 二、冻结条款(即日生效)

1. legacy **只接 P0 修复**(数据丢失 / 完全打不开),**不接新功能、不接体验优化**。
2. **不得**把新版 React 组件或样式引入 legacy(`legacy/README.md` 已写,这里是规范层的重申)。
3. 改动 legacy **必须同步更新 `legacy/source-manifest.json`** —— 否则 `legacy-snapshot.test.ts` 会红。
   这是既有的机械闸门,**不要为了让它变绿去改测试**。
4. legacy 的测试**不再新增交互用例**。`legacy.spec.ts` / `compatibility.spec.ts` 只保留
   「它还能打开」「与新版权共享数据」这两层语义 —— 它的价值是**回退**证明,不是功能证明。
5. 新版侧只在 `App.tsx` 保留一个入口链接,不要为 legacy 再铺第二个入口。

## 三、退役判据(二选一,不靠感觉)

| 判据 | 内容 | 当前可判? |
|---|---|---|
| **A. 时间窗** | 2026 电影节结束(`2026-10-15`)后**再观察 30 天**,期间无「因新版 P0 而回退到 legacy」的记录 | ✅ 可判(回退是个会被人记住的事件) |
| **B. 访问量窗** | `/legacy/` 连续 4 周访问为 0 | ❌ **当前不可判** —— 线上没有任何访问埋点(只有 `console.error` + `wrangler tail`)。要用这条判据,得先补最小可观测性 |

**当前结论**:按判据 A 走。B 作为「如果先补了埋点」的补充信号。

## 四、退役步骤(可执行清单)

1. 删 `apps/web/legacy/` 整目录。
2. `apps/web/vite.config.ts`:
   - `rollupOptions.input` 去掉 `legacy` 入口;
   - 删 `legacyRedirect` 函数与 `legacy-entry-redirect` 插件(`configureServer` / `configurePreviewServer` 两处);
   - 删 workbox 的 `manifestTransforms`(它只服务 legacy 预缓存)。
3. `apps/web/src/app/App.tsx`:删 `version-link`(指向 `/legacy/` 的那个入口)。
4. `apps/web/tsconfig.json`:`include` 去掉 `legacy/src`。
5. 删 `e2e/react/legacy.spec.ts`、`apps/web/tests/legacy-snapshot.test.ts`。
6. **保留一条 308:`/legacy` 与 `/legacy/` → `/`**(不是 404)。已装 PWA 的客户端可能仍缓存着旧路由,
   直接 404 会白屏。workbox 的 `cleanupOutdatedCaches: true` 已经在,会自动清掉旧预缓存条目。
7. 同步文档:本文件、`PLAN.md` §0/§1/§10、`docs/CONVENTIONS.md`、`AGENTS.md` / `docs/DEVELOPMENT-STANDARDS.md`
   里所有提到 legacy 的位置(含 `docs/TEST-MAP.md` 的映射)。
8. **验收**:
   - `npm run verify:full` 全绿(注意:`verify:ui` 的 spec 清单里不能还剩 legacy);
   - `ls dist/legacy` 不存在,`ls dist/assets/legacy-*` 无匹配;
   - 构建产物减少 ≈ 240 kB(未 gzip);
   - 线上 `/legacy` 与 `/legacy/` 都 308 到 `/`,且新版正常加载。

## 五、风险

| 风险 | 处置 |
|---|---|
| 已装 PWA 的旧客户端预缓存里有 legacy 条目 → 请求 404 | 步骤 6 的 308 → `/`;`cleanupOutdatedCaches` 自动清旧缓存 |
| 新版出 P0 时失去同域逃生舱 | 旧版**永远在 git 历史**(`8a95215`)。回退 = 恢复目录 + 按本文件步骤**反向**执行 + 重新部署;`source-manifest.json` 与 `legacy-snapshot.test.ts` 让恢复后的字节一致性可自证 |
| 有人误以为 legacy 是「备用的新版」继续维护 | `legacy/README.md` + 本文件 + 规范三层写明它是**只读回退件** |
| 退役后才发现还有地方引用 `/legacy/` | 步骤 8 的 `ls dist` + `verify:full` 会暴露;`grep -rn "/legacy" apps e2e docs` 是提交前的一次性复核 |
