# 补齐后的独立 review

> 本文是修复前记录。后续实现和验证见 [Review修复与旧版入口](review-fixes-and-legacy.md)。

2026-09-12。三个新子 agent 分别审查影片库与资料、排片表与交互、行程与存储/导出。旧版基线为 `8a95215`，新版为当前 `codex/react-router-spectrum` worktree。审查没有修改实现代码；运行时验证均使用独立 Playwright context，不操作用户当前标签页或存储。

确认8项P2，另有2项P3行为/文案差异和1项P3体验观察。未确认P1。此前148次E2E通过仍然有效，但未覆盖下面这些组合与边界场景。

## P2：需要修复

### 1. 残留抢票顺位会在载入后复活

初始化 `biff.picks.v2=[]`、`biff.ranks.v1={"008":2,"033":1}`，随后导入包含008、033的ICS。旧版启动时将残留顺位清为 `{}`，导入后按开场时间排008优先；新版保留残留顺位，导入后033优先，保存当前方案得到033。

新版 [store.tsx:64](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/app/store.tsx:64) 先 `loadPicks()`、后 `loadRanks()`，重建索引时还没有顺位可以清理。旧版 [main.ts:1116](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:1116) 先读顺位，随后 [main.ts:1132](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:1132) 读选片，触发 [state.ts:289](/Users/citr/Developer/GitHub/biff-scheduler/src/state.ts:289) 的prune。

两版实际启动及导入已实测。现有 [legacyRead:144](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/e2e/helpers.ts:144) 也用了错误顺序，未忠实模拟旧版启动流程，掩盖了此差异。正常UI清空仍会正确清理，本问题限于载入带残留顺位的数据。

### 2. 没有日期参数时，断点或跨午夜操作会擅自切日

模拟韩国时间10月10日，桌面打开 `/schedule` 显示10月6日；缩成手机自动切到10月10日，恢复桌面又切回10月6日。另在手机10月10日23:59:59打开同一路径，推进两秒后点选场次，会自动改显示10月11日。

新版 [SchedulePage.tsx:554](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:554) 每次渲染都根据屏幕宽度与当前日期重算默认日期。旧版 [main.ts:1126](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:1126) 只在启动时选默认值，之后保留 `currentDate`。

两种路径均实测。现有测试大多提供明确 `date`，没有覆盖默认日期在断点、午夜后的稳定性。

### 3. 场次资料串入同片另一场的特别活动

从10月9日10:00的《Mother Mary》256场打开资料，新版显示了10月7日19:00之后的Special Talk，实际属于021场。旧版256资料没有特别对谈。

新版 [ScreeningCard.tsx:249](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/ScreeningCard.tsx:249) 与甘特入口只传影片key，[FilmDialog.tsx:37](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/FilmDialog.tsx:37) 再从该片所有场次取第一个program，丢失了用户点选的CODE。旧版 [main.ts:740](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:740) 将CODE传入详情，[modal.ts:310](/Users/citr/Developer/GitHub/biff-scheduler/src/modal.ts:310) 仅使用 `programOf(code)`。

两版实际点击均验证。当前数据中另有f114、f147同时包含普通和活动场次，也受此逻辑影响。现有测试只检查活动搜索和资料是否显示，没有对同片不同场次分别断言。

### 4. 跨标签删除正在生成图片的方案，会锁住生成按钮

A标签生成最新方案的图片时，B标签删除该方案。A回退到剩余方案并卸载预览。释放图片加载后，仍保持 `data-pending=true`、`aria-disabled=true`，没有画布，也无法继续生成，直到关闭重开弹窗。

新版 [ExportDialog.tsx:193](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/ExportDialog.tsx:193) 的自动回退未经过Picker的清理分支；[ExportDialog.tsx:304](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/ExportDialog.tsx:304) 卸载预览，[PosterPreview.tsx:43](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/PosterPreview.tsx:43) 又禁止已取消任务回写，最终没有人清除busy。

已用延迟Image加载和两个独立标签实测。旧版没有跨标签同步，本项是新增同步能力引入的故障，不把“旧版没有自动切换”算回归。已有测试只测用户主动切Picker，会正常执行 `setBusy(false)`。

### 5. 购票弹窗重开仍使用过期倒计时

在 `2026-09-21T04:59:50Z` 启动并打开购票信息，显示还有9秒。关闭、推进20秒后，顶栏已为售票中；新版重开弹窗却仍显示还有9秒。旧版同操作显示已开票。

新版 [InfoDialogs.tsx:69](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/InfoDialogs.tsx:69) 的now属于持续挂载的TicketDialog，打开弹窗不会重新执行；TicketLabel自己的定时更新也不会更新它。旧版 [ticketing.ts:119](/Users/citr/Developer/GitHub/biff-scheduler/src/ticketing.ts:119) 每次打开都重新读取当前时间。

两版已实测。要求是恢复每次打开时重新计算，不是要求弹窗持续刷新。当前测试只验证不同启动时刻，没有同一会话跨开票点重开的情况。

### 6. 缩小靠右/下边界的甘特图时发生二次偏移

1440×1000，10月7日，100%时滚到最右最底。缩至90%后最大位置为 `(1255,1610)`，新版却滚到 `(1061,1453)`，额外向左194px、向上157px。

新版 [SchedulePage.tsx:163](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:163) 在DOM缩小后才读取滚动位置，此时浏览器已经按新边界clamp，再据此计算一次缩放。旧版 [main.ts:344](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:344) 在尺寸改变前保存锚点，随后重绘恢复。

实际浏览器已复现。现有缩放中心测试使用中部位置，没有触及新的最大滚动边界。

### 7. 整点筛选没有联动行程卡

加入008和011，保留行程面板，在甘特点击09:00。右侧晚场011正确变淡，但左侧两张行程卡完全不变，没有命中标记或时段说明。

旧版 [agenda.ts:241](/Users/citr/Developer/GitHub/biff-scheduler/src/agenda.ts:241) 根据 `slotDate/slotHour` 添加命中/淡化状态。新版 [ScreeningCard.tsx:164](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/components/ScreeningCard.tsx:164) 与 [AgendaPage.tsx:324](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/AgendaPage.tsx:324) 没有读取这些筛选参数。

源码与UI均确认。现有测试只检查排片表的筛选提示，不检查两侧是否一致。

### 8. 资料缺少排期韩文片名

《Mother Mary》256资料旧版显示 `마더 메리`，新版没有；《Look Back》新版保留目录日文原名 `ルックバック`，却没有排期韩文名 `룩백`。

新版 [FilmDialog.tsx:50](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/FilmDialog.tsx:50) 只显示film.en和film.names；目录命中时names并不包含排期的title_kr。旧版 [modal.ts:275](/Users/citr/Developer/GitHub/biff-scheduler/src/modal.ts:275) 独立显示anchor.title_kr。

Mother Mary两版UI已对照，Look Back新版UI和数据链已验证。现有资料测试没有韩文片名断言。

## 较低优先级

### 9. [P3] 切手机时间线后保留桌面小时筛选

桌面10月7日点击09:00后缩成手机，新版URL仍带hour=9，时间线只显示8场；旧版在断点变化时清除hourFilter，显示整天67场。新版有清除按钮，属于可恢复的旧规则差异。

旧 [main.ts:892](/Users/citr/Developer/GitHub/biff-scheduler/src/main.ts:892)；新 [SchedulePage.tsx:561](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/SchedulePage.tsx:561)。实际浏览器已复现。

### 10. [P3体验观察] 相关影片返回后重置阅读位置

1500×650下，f001资料滚到终极面试并打开，再返回，内容scrollTop从236变为0。旧modal栈保留DOM与位置；新 [FilmDialog.tsx:40](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/FilmDialog.tsx:40) 按filmKey重建。用户允许UX/UI调整，因此本项单独记录，不作为阻塞性逻辑缺陷。

### 11. [P3] 非GV场次也会被标记为“上场弃映后”

全局设置不参加GV，选择033和034后，新版赶场说明为“间隔67分钟，上场弃映后”，但上一场033是非GV。旧版先检查上一场是否有映后谈，没有则不显示弃映后标记。计算出的间隔未变，错误在说明文字。

新版 [AgendaPage.tsx:226](/Users/citr/Developer/GitHub/biff-scheduler-react-spectrum/src/pages/AgendaPage.tsx:226) 直接使用 `!talkOnOf(before.code)`；旧版 [agenda.ts:853](/Users/citr/Developer/GitHub/biff-scheduler/src/agenda.ts:853) 仅对 `gvTalkMin(prev)>0` 的场次读取参加状态。该项由CodeRabbit提示后，主agent独立浏览器复现确认。

## 审查边界

本轮没有确认新的定位token/影厅恢复、重复定位、未选GV点击、鼠标平移防误点、有效结束时间、设置取消与空值、最新导出默认或旧版图像复制降级问题。字幕/GV筛选导致手机定位目标不可见等旧版本来存在的情况未列入。

本轮只审查，以上问题尚未修复。完整测试通过并不覆盖所有状态组合；建议对修复项补充上面各自的复现场景，特别是纠正legacyRead的初始化顺序。

辅助扫描的“删除我的选片中shows.length限制”建议未纳入：旧版library.ts:1073明确使用该限制，用户要求遵循旧逻辑。PosterPreview无条件重置blob/error的建议也未纳入当前缺陷：父层每次新任务均改key并重建组件，尚无同key换model的实际路径。辅助工具结论均逐条核对，没有照单采纳。
