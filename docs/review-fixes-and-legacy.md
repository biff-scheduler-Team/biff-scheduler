# Review 修复与旧版入口

本轮继续以 `8a95215` 的实际逻辑为准，处理补齐后 review 的8项P2和3项P3，并新增 `/legacy/` 原版入口。

## 已处理的 review 问题

| 问题 | 修复 | 回归证据 |
| --- | --- | --- |
| 残留顺位复活 | 启动先读rank，再读取picks并清理；legacyRead也使用真实旧启动顺序 | `review-state.test.ts`、`review-state-export.spec.ts` |
| 默认日期自动变化 | 全应用共享一次初始化的当前日期，显式路由日期更新该值；宽度和跨午夜不会重选 | `review-schedule.spec.ts` |
| 场次资料串活动 | 资料URL保留filmCode，活动与映射取实际场次；库卡仍以首场为默认 | `film-details.test.ts`、`review-library.spec.ts` |
| 跨标签删除方案锁住图片生成 | 加载状态归属唯一生成任务；自动回退、全部删除会失效快照，旧任务不回写新任务 | `review-state-export.spec.ts` |
| 购票倒计时重开过期 | 时间戳在实际打开Dialog内容时重新取得 | `review-state-export.spec.ts` |
| 边界缩放二次偏移 | getSnapshotBeforeUpdate读取旧画布几何，尺寸更新后再恢复 | `review-schedule.test.ts`、`review-schedule.spec.ts` |
| 整点筛选不联动行程 | 同日卡片按旧版官方end_time标记命中/淡化；其他日期不受影响 | `review-shared.spec.ts` |
| 排期韩文片名遗漏 | 按实际场次补充韩文名，与原名去重 | `film-details.test.ts`、`review-library.spec.ts` |
| 手机保留桌面小时筛选 | 跨断点清除hour，保留当前日期 | `review-schedule.spec.ts` |
| 相关片返回失去位置 | 弹窗会话记住每个历史入口的内容与整框滚动位置 | `review-library.spec.ts` |
| 非GV误标弃映后 | 仅有实际GV谈段且选择不参加时显示该说明 | `review-shared.spec.ts` |

## `/legacy/`

这是真正的旧版页面，不是新版界面的模拟主题。`legacy/src/*.ts` 原样取自 `8a95215`，包含原有状态、渲染、筛选、行程与导出逻辑。HTML只适配资源路径、添加返回新版入口，CSS只限制构建扫描范围。SHA256清单与单测防止旧源码被意外改写。

Vite同时构建新版 `index.html` 和 `legacy/index.html`，两份入口分别加载各自的CSS。旧版继续读取站点根目录的同一份静态JSON与海报。新旧版同域，原 `biff.*` localStorage直接共享，切换采用整页导航并重新读取数据，不复制、不清空存储。

访问 `/legacy` 会规范到 `/legacy/`。dev/preview中由Vite middleware处理，Cloudflare静态部署使用`public/_redirects`。PWA为两种legacy路径预缓存旧HTML，离线仍能切换。

## 验证

生产测试运行在独立的31029端口，用户的31027 dev继续保留。除既有148次测试外，新增旧版实际读写互通、离线切换、历史源码完整性和本轮review复现场景。

完整执行 `npm run test:e2e` 已通过：23组、200项单元测试；TypeScript与ESLint；新版/旧版双入口生产构建和PWA生成；209次Playwright运行全部通过，0失败、0跳过，约1.2分钟。

桌面和手机旧版页面已截图检查，手机无页面横向溢出；`/legacy`规范跳转、新旧版切换、旧版选片回到新版可见、存储逐字保留、共享根JSON请求，以及断网后打开旧版和返回新版均已验证。dev31027继续运行。
