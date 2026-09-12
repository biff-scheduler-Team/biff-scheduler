# 旧版行为补齐

本轮按用户要求，以旧版 `8a95215` 的实际源码为准，补齐此前审计确认的 34 项问题。React Router 和 React Spectrum S2 保留，界面布局可以调整，数据与业务规则按旧版执行。

## 修复与回归证据

| 审计项 | 已恢复的行为 | 回归测试 |
| --- | --- | --- |
| 1 | 只保存各组第一顺位加共同场次；第一层撞片禁止保存；移除旧版已下线的枚举对比界面 | `parity-agenda.spec.ts`、`agenda-parity.test.ts` |
| 2 | 已排场次的整片删除先确认，取消保留场次、备注与顺位 | `parity-library.spec.ts` |
| 3 | 设置每次打开重新读取，取消丢弃草稿，保存不覆盖无关主题/缩放和未知字段 | `parity-dialogs.spec.ts` |
| 4 | 未选 GV 映后区首次点击加入正片并放弃映后，后续点击只翻转参加状态 | `parity-schedule.spec.ts` |
| 5 | 恢复时长默认值只清除时长覆写，保留是否参加；单场编辑确认后保存 | `parity-dialogs.spec.ts` |
| 6、34 | 图片每次打开重新生成；切方案使在途任务失效；下载与复制使用已绘制的 Blob；复制失败自动下载 | `parity-dialogs.spec.ts` |
| 7、8 | 中英文嘉宾与活动类型搜索；归并原始单元拼写，保留真实子单元 | `parity-library.spec.ts`、`model-parity.test.ts` |
| 9、10 | 选片日期多选，只影响我的选片；失效日期从选择中清除 | `parity-library.spec.ts` |
| 11、12 | 去排场次清日期、确保超40部的目标进入列表并展开定位；两页展开状态在当前面板会话中保留 | `parity-library.spec.ts` |
| 13 | 已存但不在当前排期的 CODE 明确提示，原存储记录继续保留 | `parity-library.spec.ts` |
| 14、15 | 定位解除隐藏目标的影厅筛选；桌面保留当前面板，单栏界面回到时间线；可重复定位 | `parity-schedule.spec.ts`、`parity-mobile.spec.ts` |
| 16 | 自动打开行程后确保刚点选的卡片仍在可视区 | `parity-schedule.spec.ts` |
| 17 | 手机时间线整卡可点选，内部按钮独立处理；弹窗 portal 点击不会切换背后场次 | `parity-mobile.spec.ts`、`parity-dialogs.spec.ts` |
| 18、19 | Ctrl/⌘+滚轮和捏合缩放；从卡片起拖平移，拖动结束抑制误点 | `parity-schedule.spec.ts` |
| 20 | 适应按钮与画布共用实际影厅列、时间轴和尾部留白几何 | `schedule-parity.test.ts`、`parity-schedule.spec.ts` |
| 21、22 | 当日现在线随分钟更新且不移动视口；切日期复位两轴滚动 | `parity-schedule.spec.ts` |
| 23、24 | 冲突提示列对方 CODE/片名/时间/影院，转场列缓冲与净余量；定位整天回顶并标记当天全部已选场次 | `schedule-parity.test.ts`、`parity-schedule.spec.ts` |
| 25、26、27 | 目录原始备注/首映信息、未关联豆瓣时的中英文搜索、推荐电影的年份与评分 | `parity-library.spec.ts` |
| 28 | 冲突组后不拿任意备选计算赶场余量；上一场未确定时不输出误导性连接件 | `parity-agenda.spec.ts`、`agenda-parity.test.ts` |
| 29 | 鼠标和手机触摸拖动顺位并持久化，保留键盘可操作的上下移按钮 | `parity-agenda.spec.ts`、`desktop.spec.ts` |
| 30 | 逐层撞片说明、指定哪个组让路、无可修复方案时的原因，以及自动修复预览 | `parity-agenda.spec.ts` |
| 31 | 已保存方案的有效场数、日期范围、排期失效数和具体场次；导出下拉也含概要 | `parity-agenda.spec.ts`、`parity-dialogs.spec.ts` |
| 32 | 每日票价、重叠数、折叠后的起止范围和单场票价 | `parity-agenda.spec.ts` |
| 33 | 折扣资格、购票须知、典礼与交通中文信息、明确开票批次和京韩时刻；开票后显示售票中 | `parity-agenda.spec.ts` |

## 修复时追加核对的旧规则

影片库场次只读并可定位；排场在我的选片和时间轴完成。影片资料层保留信息用途。无独立排期的目录影片不提供加入选片按钮，合集成员仍能查看和定位其放映块。

导出默认选择最新保存的方案。开票提醒固定提前30分钟，与行程提醒提前量分开。全局数字设置清空后按旧输入框语义保存0；单场 GV 时长清空则恢复跟随全局默认。

外部链接的 URL 保留协议和完整地址，只把内部路径交给 React Router。设置、导出和单场时长弹窗按打开会话重建草稿或图片状态，避免持续挂载的组件保留已取消数据。

## 验证方式

`npm run test:e2e` 先运行 TypeScript、ESLint、全部单元测试和生产构建，再在独立 `31029` 端口启动 `vite preview`。禁止复用已有服务，用户的 `31027` dev 不会参与生产测试。

覆盖桌面 Chromium、手机 Chromium 和手机 WebKit。二维甘特场景只在桌面项目执行，手机时间线场景只在手机项目执行。拖动测试在 Chromium 使用真实鼠标/CDP触摸输入，在 WebKit 使用浏览器 PointerEvents 覆盖触摸处理，设备均为浏览器模拟。

原版 localStorage 快照的逐字保留、旧实现与新实现互读、v1迁移、空v2优先和备份恢复测试继续运行。测试不会使用用户当前浏览器的存储。

2026-09-12 完整执行 `npm run test:e2e`：188项单元测试通过，TypeScript与ESLint通过，Vite/PWA生产构建通过，148次Playwright测试运行全部通过，0失败、0跳过，用时52.7秒。对应57个不同场景按适用桌面/手机配置运行。

所有34项历史审计问题均有上表对应实现和回归证据；补充复核发现的弹窗portal误触、全局空数字、外链协议问题也已修复并验证。
