import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Button, ToggleButton } from "../components/spectrum";
import { TransferAddEntry } from "../components/TransferAddDialog";
// 日程表视图与排片表共用同一个甘特组件(2026-09-21,PLAN-20260921223658):
// `scope="agenda"` 换掉图例 / 刻度 / 边界文案,`shows` 把画布收成「我的场次」。
// 图例与缩放档位也复用排片表那两只组件(2026-09-22,PLAN-20260922103307):它们的**实现**只有一份,
// 只是行程档把它们挂进了页面顶部工具栏(见下方 `toolbar`),不再挂在画布自己的 `.schedule-legend` 行里。
import {
  GanttLegendChips,
  GanttZoomControls,
  ScheduleGantt,
} from "../components/ScheduleGantt";
import { useCatalog } from "../app/store";
import { navSearch } from "../app/nav-query";
import { store, ticketInfo } from "../state";
import { totalTicketCount } from "../ticket-info";
import { dateInfo, groupByDate, todayIsoLocal } from "../util";
import { effEndMin, talkOnOf } from "../gv";
import { scorePlanRows } from "../score";
import { formatKrw, priceOf } from "../extras";
import { SCHEDULE_LABEL } from "../actions-copy";
import "./agenda-parity.css";

/* ★ 「我的行程」只有**日程表**一种形态(2026-09-30,`PLAN-20260930213528`)。
 * 用户原话:「我的行程里面只用保留日程表这种形式」。原先的 `cards`(按天卡片列表)整体下线,
 * 而它是**四处机制的唯一宿主**,故四者一并撤掉:
 *   · 抢票顺位 `RankGroup`(拖拽 / 上移 / 下移 → `setRanks`,`biff.ranks.v1`);
 *   · 按日折叠(`isAgendaFolded` / `toggleAgendaFold`,`biff.agendafold.v1`);
 *   · 票务三态 + 转票徽章(`ScreeningTicketControl` → `biff.tickets.v1`);
 *   · 行程页的「同场 N 人」标签(`SameScreeningCount`)。
 * 连带的「仅看实际行程」筛选也一起走 —— 它读的就是票务三态。
 * ⚠ 观赛范围没变:本页仍然是**只画我的场次**的甘特(`ScheduleGantt scope="agenda"`),
 *   与排片表共用同一套几何与卡片状态。 */

export function AgendaPage() {
  const { cat, codes, keyOf } = useCatalog();
  const navigate = useNavigate();
  const location = useLocation();
  // 「共 N 张票」的**唯一口径**在 `ticket-info.ts::totalTicketCount`(别在这儿现算一份):
  // 票务三态下线后它只数**票据明细**的行数(在日程表格子上右键即可填)。
  const ticketTotal = totalTicketCount(ticketInfo);
  const selected = codes
    .map((code) => cat.byCode.get(code)!)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.start_time.localeCompare(b.start_time),
    );
  const score = scorePlanRows(
    selected.map((screening) => ({ screening })),
    store.settings.transitMin,
    15,
    (s) => effEndMin(s, talkOnOf(s.code)),
  );
  // 日程表是**单日**视图,日期条只列「我有行程的日期」(排片表那条列全届日期)。
  const days = groupByDate(selected, (s) => s.date);
  // 「选中的日子」不额外存状态,由「当前行程 + 上次点的那天」派生 —— 移出行程之后
  // 不会留在一个已经不存在的日期上(否则画布会空着且日期条上没有对应项)。
  // 默认落哪天:**今天**有我的场次就落今天;今天没有就落最近的未来场次;整段都在过去则落最后一天。
  // ⚠ 别退回「直接取 days[0]」—— 电影节期间用户每次进来看到的都是已经过完的第一天。
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const dateKeys = days.map(([date]) => date);
  const today = todayIsoLocal();
  const fallbackDate = today && dateKeys.includes(today)
    ? today
    : (dateKeys.find((date) => date > today) ?? dateKeys[dateKeys.length - 1] ?? null);
  const activeDate = dateKeys.includes(pickedDate ?? "")
    ? pickedDate
    : fallbackDate;
  const dayRows = days.find(([date]) => date === activeDate)?.[1] ?? [];
  // 日期条(2026-09-22,`PLAN-20260922103307`):从画布容器里**提**到概览条下面 —— 用户原话是
  // 「作为主视图的全局日期 Filter」,它不是画布内部的装饰。夹在工具栏与画布之间时,它看起来
  // 既像工具栏的第三行、又看不出自己在筛谁。
  const dateStrip = (
    <div className="date-strip calendar-strip" aria-label="行程日期">
      {days.map(([date, rows]) => (
        <ToggleButton
          key={date}
          isSelected={date === activeDate}
          onChange={() => setPickedDate(date)}
          aria-label={`选择日期 ${date}`}
        >
          <span className="calendar-day">
            <span className="calendar-weekday">{dateInfo(date).weekday}</span>
            <span className="calendar-number">{Number(date.slice(-2))}</span>
            <span className="calendar-count">{rows.length} 场</span>
          </span>
        </ToggleButton>
      ))}
    </div>
  );
  const hasCanvas = days.length > 0;
  // 一条工具栏(2026-09-22,`PLAN-20260922103307`)—— 左组「状态 / 操作」,右组「核心操作」。
  // 改动前这里是**两行**:上一行「添加转票场次 + 仅看实际行程 + 视图切换」,下一行是画布自己的
  // 图例(时间紧张 / 时间重叠 / 韩国时间 KST)与缩放 —— 两组功能各不相同,却都横在首屏,焦点很散。
  // ⚠ 图例与缩放只属于**画布**:没有可排场次时,它们点了没有任何效果,故不渲染
  //   (别为了「看起来稳定」把死控件常驻)。
  // ⚠ 视图切换按钮(日程表 / 卡片)已随卡片视图一起删除(2026-09-30)—— 这里只剩一档,没有可切的。
  const toolbar = (
    <div className="agenda-actions">
      <div className="agenda-actions-left">
        {/* 日期导航并进工具栏(2026-09-22,`PLAN-20260922105228`):它是主视图的**全局日期 Filter**,
            不该独占一行 —— 与图例 / 操作同排,左组仍是「状态与操作」。
            ⚠ 日历卡与排片表**同一份**样式(`.date-strip.calendar-strip`),别为这一页另做小号卡。 */}
        {hasCanvas && dateStrip}
        {hasCanvas && (
          // 类名沿用排片表那条口径(`.schedule-legend`),两处共用同一份图例样式
          <div className="schedule-legend agenda-legend">
            <GanttLegendChips />
          </div>
        )}
        <TransferAddEntry />
      </div>
      <div className="agenda-actions-right">
        {hasCanvas && <GanttZoomControls />}
      </div>
    </div>
  );
  // 「选中的日子」为空只可能发生在行程为空时(那时走下面的空态分支),故这里不必再兜一层空态文案 ——
  // 原先那句「这些场次都还没标『已抢到』」是「仅看实际行程」筛选造成的,筛选已随三态下线。
  const agendaGantt = activeDate ? (
    <div className="agenda-gantt">
      <ScheduleGantt
        scope="agenda"
        date={activeDate}
        hour={null}
        shows={dayRows}
      />
    </div>
  ) : null;
  return (
    <>
      <section className="agenda-page" aria-label="我的行程">
        <div className="panel-heading">
          <div>
            {/* ⚠ 副标题**必须**留在 `h1` 外面:塞进去会把标题的 accessible name 污染成
                「我的行程 挑场次，留备选」,`getByRole("heading", { name: "我的行程" })` 会全线失配
                (与「豆瓣入口别塞进片名 h3」同一课)。同行只靠这一行的 flex 对齐实现。 */}
            <div className="agenda-title-row">
              <h1>我的行程</h1>
              {/* 这句原先独立占一行:收成同行(2026-09-22,`PLAN-20260922105228`)——
                  首屏每压掉一行,画布就早一步进视野。文案 / 字阶都没变,只是不再独占一行。 */}
              <p className="eyebrow-inline">挑场次，留备选</p>
            </div>
          </div>
          {/* 概览微型化(2026-09-22,`PLAN-20260922105228`):原先它独占一行、还带一条分隔线,
              把画布往下推了 36px —— 这些数字是**读一眼**的东西,做成标题右侧的灰 tag 就够。 */}
          <div className="agenda-overview" aria-label="行程概览">
            <span className="overview-tag">
              {new Set(selected.map((s) => keyOf(s.code))).size} 部电影
            </span>
            <span className="overview-tag">{days.length} 天</span>
            {/* 「有几张票」(2026-09-24,`PLAN-20260924141442`)。⚠ 它与上面那条**不是一个口径**:
                那条数**场次**,这条数**张数**(一场可能买 2 张,在日程表上右键格子填)。
                两者刻意并存 —— 筛选用的是场次,「我手上有几张票」才是张数。
                ⚠ 票务三态下线后(2026-09-30)它**只数票据明细**:没填明细的场次一张也不算。 */}
            <span
              className="overview-tag"
              title="按手填的票据明细合计（座位行数 = 张数）；在日程表格子上右键即可填"
            >
              共 {ticketTotal} 张票
            </span>
            <span className="overview-tag">
              {formatKrw(selected.reduce((n, s) => n + priceOf(s), 0))}
            </span>
            <span
              className="overview-tag"
              title={`场次 ${score.count} + GV ${score.gv} − 紧转场 ${score.tight}`}
            >
              质量分 {score.total}
            </span>
            <span className="count" aria-live="polite">
              {codes.length} 场
            </span>
          </div>
        </div>
        {toolbar}
        {codes.length === 0 ? (
          <div className="empty-state">
            <h2>还没有安排场次</h2>
            <p>从排片表把场次{SCHEDULE_LABEL}，或先到影片库挑选电影。</p>
            {/* 跨页导航走 `nav-query` 口径:只带排片表的 `date` / `hour`,不搬本页 / 上一页的搜索词 */}
            <Button onPress={() => navigate(`/library${navSearch(location.search, location.pathname, "/library")}`)}>
              浏览影片库
            </Button>
          </div>
        ) : (
          agendaGantt
        )}
      </section>
      <Outlet />
    </>
  );
}
