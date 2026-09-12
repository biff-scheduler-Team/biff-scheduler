# React Router 与 React Spectrum 重写

本次修改从 `8a95215` 开始，在 `codex/react-router-spectrum` 分支完成。界面由 React 19、React Router 8.3.1 和 React Spectrum S2 1.7.1 负责。原有数据管线、静态资源和业务规则继续保留。

## 存储协议

| 键 | 原有格式与新版行为 |
| --- | --- |
| `biff.picks.v2` | `[{key,picks:[{code}],note}]`。`cat:<id>`、`sched:<小写英文名>` 和场次编号不变。读取时忽略已废弃的 `priority`、`group`，不自动改写原字符串。 |
| `biff.settings.v1` | `alarmMin`、`transitMin`、`gvTalkOn`、`gvTalkMin`、`theme`、`zoom`。更新设置时保留未知字段。 |
| `biff.gvtalk.v1` | 场次编号到布尔值的对象，缺省使用全局配置。 |
| `biff.gvtalkmin.v1` | 场次编号到映后分钟数的对象。 |
| `biff.ranks.v1` | 场次编号到顺位的对象，调整时归一为组内 `1..n`。 |
| `biff.agendafold.v1` | 已折叠日期的字符串数组。 |
| `biff.savedplans.v1` | `[{id,name,codes,createdAt}]`，保持原快照和去重规则。 |
| `biff.filters.v1` | 排片表筛选：`{subs,venues,venueMode,gv}`。 |
| `biff.libfilters.v1` | 影片库独立筛选，格式同上。 |
| `biff.pickerw.v1` | 面板宽度的数字字符串。读取限制在 520–800，未设置时自适应；双击分隔线清除宽度偏好。 |
| `biff.plan.v1`、`biff.wish.v1` | 仅在缺少有效 v2 数组时按原实现迁移。迁移保留有效场次和备注；已废弃的意愿档位不转换，迁移成功后移除旧键。 |
| 其他 `biff.*` | 保留原字符串，并自动包含在备份中。 |

兼容性边界遵循原代码：移除最后一场且备注为空时，会删除该影片的空记录；有备注的影片保留为未排场。空的 v2 数组始终优先于残留 v1 数据。两项行为由 E2E 验证。

备份信封继续使用 `{app:"biff-scheduler",version:1,exportedAt,origin,data}`，也接受裸 `biff.*` 键值表。备份内容的值保持 localStorage 原字符串。恢复只修改 `biff.*`，不触碰其他应用的存储。

在同一 origin 部署后，原数据可以直接读取。不同端口或域名是不同 origin，需要导出和导入备份。

## 界面与计算

React 通过 `useSyncExternalStore` 订阅原状态模块，统一派生影片、场次、冲突与方案。跨标签页修改通过 `storage` 事件同步。没有新的数据后端，也没有框架专用的数据迁移副本。

路由维持桌面双栏工作台，并为详情、搜索和日期提供可恢复的 URL。静态 JSON 全部使用站点根路径，避免深层路由把请求解析到错误目录。React Spectrum 管理控件、焦点、弹窗、选择器和通知。

保留 GV 的全局默认与单场覆写、跨午夜 `24+` 小时格式、原有冲突分组、顺位成本、方案枚举、日历时区和提醒口径。`conflict.ts` 原有按放映日期分桶的边界没有改变：相邻日期之间的跨午夜重叠仍不组成同一冲突组。

影片详情按旧版只展示资料，不提供排场。GV时长在选片或行程中确认保存，弹窗 portal 的点击被排除在整卡点选之外。备份编辑器固定高度，防止自动测量高度在鼠标按下与释放之间移动确认按钮。

## 测试

运行：

```sh
npm ci
npx playwright install chromium webkit
npm run test:e2e
```

`test:e2e` 包含生产构建前的 TypeScript、ESLint 与单元测试。Playwright 测试真实生产 bundle，桌面 Chromium 使用 1512×982 视口，手机配置使用 Pixel 7 和 iPhone 13。它们是浏览器设备模拟，未替代真机验收。

测试包括：

- 全部旧存储键的逐字无改写读取、v1 迁移、空 v2 优先与清空后不复活。
- 新版写入交给旧版读取，再由旧版修改并让新版读取。
- 选片、备注、场次、独立筛选、GV、顺位、方案保存与修复。
- JSON 下载与恢复，ICS 文件导入、时区与结束时间，真实 PNG 文件生成。
- 路由刷新、后退、资料返回、GV弹窗、键盘焦点与手机横向溢出。
- 跨标签页同步、缺失数据恢复、未知影片、场次定位。
- 桌面拖动排序、跨视图高亮和缩放锚点。
- Chromium 下安装 PWA 后断网，从深层路由恢复选片与备注。

`e2e/fixtures/legacy-state.ts.txt` 是原提交 `8a95215` 的 `src/state.ts` 快照。测试只替换其无关的豆瓣加载依赖，转译后在浏览器中执行原版读写方法。兼容性测试不会把新实现当成旧版判定依据。

原有 16 组、173 项领域单元测试继续保留。浏览器测试的最新结果可通过 `playwright-report/index.html` 查看，失败时自动保留 screenshot 与 trace。

## 首轮验证记录（后续以补齐报告为准）

2026-09-12 在本地生产产物上运行：TypeScript、ESLint、173 项单元测试和 69 项 Playwright E2E 全部通过。浏览器测试共用时 41.1 秒，失败数为 0。桌面、手机时间线和影片详情另经截图检查。

本轮按旧版逻辑补齐功能后的验证和逐项映射见 [旧版行为补齐](parity-restoration.md)。首轮69次通过未覆盖全部旧UI分支，不能作为功能对等结论。

2026-09-12 补齐后完整验证：188项单元测试与148次E2E运行全部通过，0失败、0跳过。后续以[补齐报告](parity-restoration.md)为准。
