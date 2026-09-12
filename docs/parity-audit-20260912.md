# 新旧版功能对照审计

> 本文是修复前的审计快照。按旧版逻辑完成的后续修复及测试映射见 [旧版行为补齐](parity-restoration.md)。

2026-09-12。旧版基线为 `8a95215`；新版为 `codex/react-router-spectrum` worktree 的当前源码。三个独立子 agent 分别审计影片库/资料、排片表/交互、行程/存储/导出，主 agent 复核源码并补做设置流程的新旧浏览器对照。

本次仅审计，未修改实现代码。表中“实测”使用各自独立的 Playwright 浏览器上下文与合成 localStorage；没有操作用户正在浏览的标签页。

结论：原 localStorage 键和序列化格式保留，并不等于功能对等。此前“完整重写”的结论过早；下面是已确认的遗漏或行为回退。P1 应优先处理，P2 为常规功能回归，P3 为信息或辅助交互遗漏。

## 选择、设置与导出

### 1. [P1] 保存当前方案会自行替换第一顺位

008/033 为一组、143/080 为另一组，008 与 143 同片且均为顺位 1。旧版禁止保存并要求处理撞车；新版按钮可用，实际保存 008+080，抢票顺位却仍是 143:1。丢失了“只保存用户第一顺位、撞车先处理”的约束。

证据：两版浏览器实测。旧版 [src/agenda.ts:695](/Users/citr/Developer/GitHub/biff-scheduler/src/agenda.ts:695)；新版 [src/pages/AgendaPage.tsx:154](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/AgendaPage.tsx:154)。

测试缺口：已有单组保存测试未测第一层同片撞车；修复测试只检查改顺位。

### 2. [P2] 整片删除少了确认

已有场次的影片在旧版删除前确认。新版点击一次就直接删除该片全部场次、备注和相关顺位。以有备注的 001 实测，新版 picks 立即变为空数组。

证据：新版实测＋旧版源码。旧版 [src/library.ts:1325](/Users/citr/Developer/GitHub/biff-scheduler/src/library.ts:1325)；新版 [src/pages/LibraryPage.tsx:94](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/LibraryPage.tsx:94)。

测试缺口：原测试的 remove 仅为单场移出，没有整片删除及取消确认。

### 3. [P2] 设置少了取消回滚和重新打开时刷新

把提醒从 45 改为 90 后取消，旧版重开为 45，新版仍为 90。另从已存 light/0.7 开始，在顶栏改为 dark/0.9，随后打开设置直接保存：旧版保留 dark/0.9，新版写回旧的 light/0.7。两个症状都来自持续挂载的旧 draft。

证据：两版浏览器实测。旧版 [src/settings.ts:70](/Users/citr/Developer/GitHub/biff-scheduler/src/settings.ts:70)；新版 [src/components/SettingsDialog.tsx:65](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/SettingsDialog.tsx:65)。

测试缺口：现有设置测试未覆盖取消后重开、顶栏变更后保存设置。

### 4. [P1] 未选 GV 映后区的点击含义反转

旧版点未选场的映后区域表示加入正片并放弃映后；新版表示加入并参加。001 实测分别得到 talk=false / true，默认结束时间相差 25 分钟，冲突和导出也随之变化。

证据：两版浏览器实测。旧版 [src/main.ts:745](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:745)；新版 [src/pages/SchedulePage.tsx:390](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:390)。

测试缺口：现有 GV 测试从已选卡片的复选框开始，未测未选映后块首次点击。

### 5. [P2] 单独恢复映后时长默认值的能力丢失

旧版“跟随默认”只清除时长覆写；新版“恢复全局默认”同时清除是否参加的覆写。只想恢复时长时，原先不参加的场次也可能重新参加。

证据：源码确定。旧版 [src/settings.ts:206](/Users/citr/Developer/GitHub/biff-scheduler/src/settings.ts:206)；新版 [src/components/ScreeningCard.tsx:96](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/ScreeningCard.tsx:96)。

测试缺口：未测试恢复时长后是否参加保持不变。

### 6. [P2] 分享图片关闭重开或生成中换方案会失效

生成后关闭、重开，新版 imageReady 仍为 true，但新 canvas 是 300×150 透明空图，下载仍可用。生成方案 1 的海报途中切到方案 2，旧任务完成后还会画出方案 1，下载与选择不符。旧版每次打开独立海报弹层固定 rows 并重新绘图。

证据：新版浏览器实测＋旧版源码。旧版 [src/poster-panel.ts:47](/Users/citr/Developer/GitHub/biff-scheduler/src/poster-panel.ts:47)；新版 [src/components/ExportDialog.tsx:168](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/ExportDialog.tsx:168)。

测试缺口：现有测试只验证一次单方案 PNG 的签名和大小，没有重开、切方案、内容验证。

## 影片库与选片

### 7. [P2] 嘉宾与活动形式搜索未迁移

新版搜索范冰冰、李敏镐、演员之家、大师班、电影课、特别对谈均为 0。旧版会查询 extras 的中英文嘉宾及活动标签，例如范冰冰能找到相关节目。活动单元 Picker 仍存在，但不能替代按嘉宾搜索。

证据：两版浏览器实测。旧版 [src/library.ts:128](/Users/citr/Developer/GitHub/biff-scheduler/src/library.ts:128)；新版 [src/app/model.ts:78](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/app/model.ts:78)。

测试缺口：只测片名搜索，未测嘉宾和活动词。

### 8. [P2] 单元归并未迁移

旧版把年度亚洲电影人奖的四条原始单元归为一个选项、共 4 部；新版按原值去重、仅归一显示文字，产生四个同名选项，每个只筛出 1 部。

证据：两版数据与 UI 验证。旧版 [src/library.ts:74](/Users/citr/Developer/GitHub/biff-scheduler/src/library.ts:74)；新版 [src/pages/LibraryPage.tsx:171](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/LibraryPage.tsx:171)。

测试缺口：unitLabel 单测只检查显示文案，不检查选项归并及命中集合。

### 9. [P2] 选片日期由多选退化为单选

旧版能同时选择 OCT 7 和 OCT 8，只看这两天可选场次。新版只有单个 pickDate，选第二天会替换第一天。

证据：源码确定。旧版 [src/library.ts:739](/Users/citr/Developer/GitHub/biff-scheduler/src/library.ts:739)；新版 [src/pages/LibraryPage.tsx:246](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/LibraryPage.tsx:246)。

测试缺口：没有选片日期多选场景。

### 10. [P2] 选片日期泄漏为影片库隐藏筛选

选片页选 OCT 7 后进入影片库，App 保留整个 query，新版影片库继续应用 pickDate，却没有日期控件。实测彼此的日夜消失。旧版只在选片页应用该日期集合。

证据：新版浏览器实测＋旧版源码。旧版 [src/library.ts:994](/Users/citr/Developer/GitHub/biff-scheduler/src/library.ts:994)；新版 [src/pages/LibraryPage.tsx:169](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/LibraryPage.tsx:169)。

测试缺口：现有独立筛选测试只检查两个 localStorage 筛选键，没有路由日期隔离。

### 11. [P2] “去排场次”不再保证目标可见

选片 60 部，在影片库搜第 60 部 f060 后点击去排场次。新版虽设置 expand=f060，却只渲染前 40 部，目标不在 DOM；旧版清日期、展开、滚到目标并高亮。

证据：新版浏览器实测＋旧版源码。旧版 [src/library.ts:1238](/Users/citr/Developer/GitHub/biff-scheduler/src/library.ts:1238)；新版 [src/pages/LibraryPage.tsx:84](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/LibraryPage.tsx:84)。

测试缺口：现有跳转测试仅测第一部 f001。

### 12. [P2] 跨视图与筛选变化后丢失展开状态

影片库展开 f001，切到我的选片再回来，新版恢复折叠。筛选变化也因列表 key 重建而清掉手动展开态；旧版两份展开集合在同一抽屉会话中保留。

证据：跨视图已实测；筛选分支源码确定。旧版 [src/library.ts:727](/Users/citr/Developer/GitHub/biff-scheduler/src/library.ts:727)；新版 [src/pages/LibraryPage.tsx:35](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/LibraryPage.tsx:35)。

测试缺口：只检查详情返回的搜索词，未检查场次展开状态。

### 13. [P2] 数据换版后的失效场次提示消失

旧 v2 中保留已经不存在的 code 时，新版卡片仍计入已排数量，却只列当前 shows，行程又过滤旧 code，没有解释差异。旧版会明确提示另有 N 场不在当前排期。原字符串仍在，属于展示与数据解释遗漏。

证据：源码确定。旧版 [src/library.ts:920](/Users/citr/Developer/GitHub/biff-scheduler/src/library.ts:920)；新版 [src/pages/LibraryPage.tsx:69](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/LibraryPage.tsx:69)。

测试缺口：未覆盖 v2 旧 code 与当前目录混合。

## 排片表与定位

### 14. [P1] 定位不会解除挡住目标的影厅筛选

排片筛选排除 br，再定位 001。旧版清除影厅筛选后出现目标；新版仍排除 br，目标继续不存在。需用户自己清筛选再定位。

证据：两版浏览器实测。旧版 [src/main.ts:981](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:981)；新版 [src/pages/SchedulePage.tsx:93](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:93)。

测试缺口：现有定位测试使用无筛选场景。

### 15. [P2] 桌面定位会强制收起选片或行程面板

旧版只在手机收起面板，桌面保持双栏以便连续定位。新版一律跳 /schedule，桌面左侧面板也被卸载。

证据：两版浏览器实测。旧版 [src/main.ts:994](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:994)；新版 [src/components/ScreeningCard.tsx:188](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/ScreeningCard.tsx:188)。

测试缺口：测试只验 URL 和目标焦点，没有检查桌面面板仍在。

### 16. [P2] 自动展开行程后缺少视野补偿

甘特点选 009 后自动打开左侧行程，新版网格可视区域被挤窄，刚选的卡片整张落到右边视口外。旧版记住 lastToggledCode 并确保它仍在视野里。

证据：两版浏览器实测。旧版 [src/main.ts:954](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:954)；新版 [src/pages/SchedulePage.tsx:55](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:55)。

测试缺口：未检查自动打开面板后的选中卡位置。

### 17. [P2] 手机时间线少了整卡点选

旧版点击海报、标题或卡片空白都可加入/移出。新版只有独立操作按钮能切换；点击 001 卡片内容，旧版加入、新版无动作。按钮能力仍在。

证据：两版浏览器实测。旧版 [src/timeline.ts:191](/Users/citr/Developer/GitHub/biff-scheduler/src/timeline.ts:191)；新版 [src/components/ScreeningCard.tsx:139](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/ScreeningCard.tsx:139)。

测试缺口：现有移动端测试只点击加入/移出按钮。

### 18. [P2] Ctrl/⌘+滚轮和触控板捏合缩放丢失

旧版捕获网格内 Ctrl/Meta wheel、改变甘特倍率并阻止整页缩放。新版没有对应 handler，只剩缩放按钮。实测 deltaY=60：旧 1→0.9，新不变。

证据：两版浏览器实测。旧版 [src/main.ts:856](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:856)；新版 [src/pages/SchedulePage.tsx:191](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:191)。

测试缺口：缩放只测按钮，没有 wheel/pinch 事件。

### 19. [P2] 电影卡片上无法起拖平移

旧版允许从卡片起拖并吞掉误点击。新版遇到 button/a 就不启动平移，卡片主体正是 button。实测横拖 100px，旧 scrollLeft 350→450，新仍 350。空白区域和滚动条仍可平移。

证据：两版浏览器实测。旧版 [src/grid.ts:449](/Users/citr/Developer/GitHub/biff-scheduler/src/grid.ts:449)；新版 [src/pages/SchedulePage.tsx:230](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:230)。

测试缺口：已有拖拽测试是行程顺位，不是甘特平移。

### 20. [P2] “适应”计算未同步新版列宽

fitZoomLevel 使用旧 labelMetrics，新画布实际使用 148×zoom。800px 视口下，10/6 点击适应选择 100%，新版画布 748px 大于容器 736px，仍横向溢出；旧版同宽可以适应。

证据：两版浏览器实测。旧版 [src/grid.ts:116](/Users/citr/Developer/GitHub/biff-scheduler/src/grid.ts:116)；新版 [src/pages/SchedulePage.tsx:81](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:81)。

测试缺口：现有缩放测试未断言“适应”后 scrollWidth≤clientWidth。

### 21. [P2] 当前时刻线和分钟刷新未迁移

固定在 2026-10-07 12:00 KST，旧版有“现在 12:00”标签及各行现在线，并按分钟更新。新版只有整点刻度，没有现在线。

证据：两版固定时钟实测。旧版 [src/grid.ts:310](/Users/citr/Developer/GitHub/biff-scheduler/src/grid.ts:310)；新版 [src/pages/SchedulePage.tsx:271](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:271)。

测试缺口：未测试电影节当天的当前时刻显示。

### 22. [P2] 切换日期不再复位滚动位置

10/7 先滚到 left=500/top=700，再切 10/8。旧版回到 0/0，新版保留 500/700，可能直接展示新一天的中后段。

证据：两版浏览器实测。旧版 [src/main.ts:533](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:533)；新版 [src/pages/SchedulePage.tsx:497](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:497)。

测试缺口：未覆盖滚动后切日。

### 23. [P2] 冲突对象和转场算式的就地说明缺失

旧版悬停可读对方 code、片名、时间、影厅，以及间隔减缓冲得到的净余量；新版只剩“与已选场次时间重叠”或“转场余量不足15分钟”。行程可补看部分信息，但当前位置解释能力减少。

证据：源码确定。旧版 [src/grid.ts:534](/Users/citr/Developer/GitHub/biff-scheduler/src/grid.ts:534)；新版 [src/pages/SchedulePage.tsx:352](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:352)。

测试缺口：仅测冲突计算和联动，未测可读说明字段。

### 24. [P3] 定位整天退化为定位第一场

旧版日期定位回到网格顶部并让当天全部已选场次闪烁；新版只设置 focus=第一场，只标记一张卡。

证据：源码确定。旧版 [src/main.ts:1034](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:1034)；新版 [src/pages/AgendaPage.tsx:359](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/AgendaPage.tsx:359)。

测试缺口：定位测试只有单场，没有当天多场回执。

## 资料与辅助信息

### 25. [P3] 目录资料缺少原始备注/首映信息

如 f219 Beneath the Barren 的 International Premiere，旧版目录资料展示 remark，新版没有渲染该字段。

证据：真实目录数据＋源码确定。旧版 [src/modal.ts:354](/Users/citr/Developer/GitHub/biff-scheduler/src/modal.ts:354)；新版 [src/pages/FilmDialog.tsx:55](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/FilmDialog.tsx:55)。

测试缺口：无目录及合集成员 remark 字段断言。

### 26. [P3] 无豆瓣映射时少了中文搜索入口

旧版提供中文、英文两条搜索链接，新版仅用 film.en 生成英文搜索。

证据：源码确定。旧版 [src/modal.ts:417](/Users/citr/Developer/GitHub/biff-scheduler/src/modal.ts:417)；新版 [src/pages/FilmDialog.tsx:65](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/FilmDialog.tsx:65)。

测试缺口：未测无映射的搜索链接选项与搜索词。

### 27. [P3] 相关电影少了年份和评分

旧版相关电影条目显示 year/rating，新版本届与站外推荐都只显示片名。数据仍加载，未渲染。

证据：源码确定。旧版 [src/modal.ts:510](/Users/citr/Developer/GitHub/biff-scheduler/src/modal.ts:510)；新版 [src/pages/FilmDialog.tsx:149](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/FilmDialog.tsx:149)。

测试缺口：related 单测仅测分类与加载，PNG/详情测试不验证推荐元信息。

## 行程与购票补充

### 28. [P2] 冲突组后的赶场间隔取错备选

008/033 冲突，008 为首选，再接 034，缓冲 45 分钟。新版取紧邻原始 rows 的 033 计算，显示间隔 67 分钟；首选 008 到 11:20 才结束、12:00 的 034 需跨馆，净余量实际为 −5 分钟。旧版在冲突组后清空 prev，上一场不唯一时不输出误导连接件。

证据：两版源码＋新版浏览器实测。旧版 [src/agenda.ts:185](/Users/citr/Developer/GitHub/biff-scheduler/src/agenda.ts:185)；新版 [src/pages/AgendaPage.tsx:382](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/AgendaPage.tsx:382)。

测试缺口：未覆盖冲突组后还有非冲突场次的转场说明。

### 29. [P2] 手机触摸拖动顺位失效

390px 触摸环境，拖动 008 和 033 换位。旧版写入 033:1/008:2，新版顺序不变且不写入。新把手只有 HTML draggable，缺少旧版 pointer/touch 重排。上下移按钮仍可用。

证据：两版真实触摸事件实测。旧版 [src/agenda.ts:265](/Users/citr/Developer/GitHub/biff-scheduler/src/agenda.ts:265)；新版 [src/pages/AgendaPage.tsx:66](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/AgendaPage.tsx:66)。

测试缺口：移动端测试通过点击提高顺位来模拟排序；真正拖动只在桌面执行。

### 30. [P2] 顺位撞车少了逐条诊断与指定哪组让路

旧版显示具体层数、电影、涉及组，并给每组改选按钮；不能让路时解释原因。新版只有泛化提示和自动修复预览，无法就地选择让哪一组改选；没有自动修复变化时按钮禁用，也缺少原因。

证据：源码确定。旧版 [src/agenda.ts:588](/Users/citr/Developer/GitHub/biff-scheduler/src/agenda.ts:588)；新版 [src/pages/AgendaPage.tsx:210](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/AgendaPage.tsx:210)。

测试缺口：未测逐组改选、无可行自动修复时的解释。

### 31. [P3] 已保存方案概要信息减少且失效口径改变

旧版显示有效场数、日期范围、排期失效数，悬停可读具体时间和 code。新版只显示原始 code 总数与“不在当前行程”，不能区分有效但已移出行程的快照场次与当前目录根本不存在的场次；导出下拉也少了日期范围。

证据：源码确定。旧版 [src/agenda.ts:763](/Users/citr/Developer/GitHub/biff-scheduler/src/agenda.ts:763)；新版 [src/pages/AgendaPage.tsx:318](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/AgendaPage.tsx:318)。

测试缺口：仅测试方案名和原始存储，未核对概要。

### 32. [P3] 行程按日概要和普通场次票价减少

旧日期头有当日票价、重叠计数，折叠后仍显示起止时间；每场有票价。新版日期头仅日期和场数，共用普通场次卡也没有票价。全行程总价仍保留。

证据：源码确定。旧版 [src/agenda.ts:129](/Users/citr/Developer/GitHub/biff-scheduler/src/agenda.ts:129)；新版 [src/pages/AgendaPage.tsx:346](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/AgendaPage.tsx:346)。

测试缺口：折叠测试仅验证按钮和偏好，不验证摘要字段。

### 33. [P2] 购票折扣资格限制丢失

旧版明确优惠适用于65岁以上、残障、退伍军人并需证件核验。新版只显示折扣金额，容易被理解为普遍优惠。购票须知与典礼/交通管制中文解释也有删减；顶栏不再列批次、京韩明确开票时刻，全部开票后也不再标示售票中。详细弹窗仍提供各批时间。

证据：源码确定。旧版 [src/ticketing.ts:146](/Users/citr/Developer/GitHub/biff-scheduler/src/ticketing.ts:146)；新版 [src/components/InfoDialogs.tsx:98](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/InfoDialogs.tsx:98)。

测试缺口：购票测试只检查北京时间文案和提醒 ICS 的 UTC 格式。

### 34. [P3] 复制图片失败后少了自动下载

旧版剪贴板复制失败会自动下载图片。新版只给错误提示，需要用户再次点击下载。显式下载按钮仍存在。

证据：源码确定。旧版 [src/poster-panel.ts:94](/Users/citr/Developer/GitHub/biff-scheduler/src/poster-panel.ts:94)；新版 [src/components/ExportDialog.tsx:308](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/ExportDialog.tsx:308)。

测试缺口：未测试复制路径或权限失败分支。

## 已确认保留与排除项

没有发现旧存储键或序列化格式被整体替换。state.ts 的核心读写保持原逻辑；新增了 setPickNote。冲突和方案计算模块、ICS 生成、备份快照与解析、分享文案及海报绘图也沿用。上文的问题大多发生在 React 界面的操作语义、状态生命周期和信息展示。

默认日期、两套独立筛选与持久化、双栏工作台、面板宽度记忆及520–800范围、双击复位、Escape收起、跨视图高亮均保留。上下移顺位按钮、路由、键盘分隔条等为新版提供的能力，不能据此忽略旧手势缺失，也不能将有替代入口的能力写成完全不存在。

没有把旧版本来存在的跨午夜冲突分桶边界、清空空记录规则或非事务式备份恢复列为新回归。也没有把中等宽度下隐藏右侧甘特当作新问题：两版都有该布局规则。

另有一处方向变化：旧 agenda.ts:691 明确以已保存方案替代枚举对比区，新版 AgendaPage.tsx:253 又展示枚举“方案对比”。这不是缺失项，但应核对是否符合用户已经确认的流程。

55%缩放下文本裁切尚未得到足够清楚的损失实例，不计入上述34项确认清单。

## 测试结论需要更正

此前的69次E2E通过是25个不同场景在浏览器配置中的运行结果，不是功能对等检查。测试采用原版state.ts快照验证了数据读写，却没有逐条覆盖旧UI的操作。最明显的盲点是：只点排序按钮、只定位无筛选的第一部影片、只生成一次PNG并校验文件头，以及不检查取消设置和图片重开。

测试服务还有可复现性问题：[playwright.config.ts:38](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/playwright.config.ts:38) 把preview和dev都设在31027，并允许复用现有服务。当前该端口运行dev，首页含/@vite/client；此时复跑test:e2e可误测dev而非刚构建的产物。此前69次通过时运行的是preview，这一问题不推翻那次结果，但应使用独立测试端口和服务标识。

## 后续修复顺序

先处理会改变选择或结果的分支：保存当前方案、GV点击语义、设置草稿、整片删除确认、图片生命周期，以及冲突组后的转场说明。再恢复定位可见性、日期和搜索功能、手机拖动及缩放/平移手势。最后补齐资料、方案概要与说明字段，并为每个已复现分支增加回归测试。

此报告截至本次审计仍有34项确认的缺失或行为回退，尚未修复。

补充说明：CodeRabbit辅助扫描已完成，返回文档编号、徽章样式和依赖版本下限三条建议。文档编号不属于功能遗漏；直接恢复旧Tailwind类不适用于已移除Tailwind的实现；降低Spectrum依赖下限也未给出可复现故障。因此三条建议未计入上述34项，报告结论以子agent源码对照和浏览器复现为依据。
