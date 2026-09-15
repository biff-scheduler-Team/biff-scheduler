// 「抢票」页(2026-09-15,`PLAN-20260915234414`)——
// 把**我的行程**里的场次按**开票批次**分组:第 1 批(9/17 14:00 KST)/ 第 2 批(9/21 14:00 KST)。
//
// ★ 为什么单开一页,而不是在「我的行程」里加个视图:
//   抢票当天真正要看的只有两件事 ——「这一批几点开」「我这一批要抢哪几场」;
//   行程页那套「按天分组 + 顺位卡」是**选片期**的视角,批次是**开票期**的视角,两者按日期分的并不是同一件事。
//
// ★ 口径全部复用,不另起一套:
//   · 批次判据 = `batch.ts::ticketBatchOf`(**唯一来源**,分享文案的批次分节也用它,勿在此重判一次);
//   · 开票时间 / 节头 / 倒计时 = `extras.ts::ticketOpens` / `batchHeading` / `countdownText`
//     (与顶栏「距第 N 批开票」同源);
//   · 场次卡 = `ScreeningCard`(与行程页同一张卡,自带票务三态「已抢到 / 没抢到 / 放弃」与票价)。
//
// ⚠ 社区 BIFF 的场次**不在本站排期数据里**(见 `docs/plans/PLAN-20260914143817.md` 的「不做」),
//   所以本页不会出现它们 —— 页脚说明里写明,免得用户以为漏了。

import { useEffect, useState } from "react";
import { Link } from "../components/spectrum";
import { ScreeningCard } from "../components/ScreeningCard";
import { useCatalog } from "../app/store";
import { useScheduleSelection } from "../app/schedule-selection";
import { BATCH_CATEGORY_EN, groupCodesByBatch } from "../batch";
import { batchHeading, countdownText, extras, nextTicketOpen, programOf, ticketOpens } from "../extras";
import { tickets } from "../state";
import { actualCodeSet } from "../tickets";
import "./agenda-parity.css";

export function RushPage() {
  const slotFilter = useScheduleSelection();
  const { cat, codes } = useCatalog();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    // 倒计时每秒刷新;后台标签页不刷(与 `InfoDialogs.tsx::TicketLabel` 同口径,省电)
    const update = () => {
      if (!document.hidden) setNow(Date.now());
    };
    const id = setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const year = cat.schedule.festival.year;
  const opens = ticketOpens(year);
  const groups = groupCodesByBatch(cat, codes, { kindOf: (code) => programOf(code)?.kind });
  const actual = actualCodeSet(tickets);
  const total = groups.reduce((sum, group) => sum + group.screenings.length, 0);
  const next = nextTicketOpen(year, now);
  const nextBatch = next ? opens.findIndex((open) => open.at === next.at) + 1 : null;
  const bookingUrl = extras()?.ticketing.bookingUrl;

  return (
    <section className="agenda-page" aria-label="抢票">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">按开票批次抢</p>
          <h1>抢票</h1>
        </div>
        <span className="count" aria-live="polite">
          {codes.length} 场
        </span>
      </div>
      <div className="summary-strip">
        <span>{total} 场待抢</span>
        <span title="票务状态标为「已抢到」的场次（含转票补入）">
          已抢到 {actual.size} 场
        </span>
        <span>
          {next && nextBatch
            ? `距第 ${nextBatch} 批开票 ${countdownText(next.at - now)}`
            : "两批均已开票"}
        </span>
        {bookingUrl && (
          <Link href={bookingUrl} target="_blank" rel="noopener noreferrer">
            在线购票入口 ↗
          </Link>
        )}
      </div>
      {groups.length === 0 ? (
        <div className="empty-state">
          <h2>还没有安排场次</h2>
          <p>从排片表把要抢的场次加进行程，这里会按开票批次把它们分开。</p>
        </div>
      ) : (
        <div className="agenda-days">
          {groups.map((group) => {
            const open = opens[group.batch - 1];
            const got = group.screenings.filter((s) => actual.has(s.code)).length;
            return (
              <article className="ticket-batch" key={group.batch} data-ticket-batch={group.batch}>
                <h3>{batchHeading(year, group.batch)}</h3>
                <p>
                  {open
                    ? open.at > now
                      ? `还有 ${countdownText(open.at - now)} 开票`
                      : "已开票"
                    : "开票时间未收录，以官网为准"}
                </p>
                <p className="muted">{BATCH_CATEGORY_EN[group.batch]}</p>
                <p className="muted">
                  {group.screenings.length} 场{got ? ` · 已抢到 ${got} 场` : ""}
                </p>
                <div className="day-screenings">
                  {group.screenings.map((s) => (
                    <ScreeningCard
                      key={s.code}
                      screening={s}
                      locate
                      controls
                      venueInfo
                      slotFilter={slotFilter}
                      social
                    />
                  ))}
                </div>
              </article>
            );
          })}
          <p className="muted">
            批次按官网品类推算：开闭幕 / 露天剧场（Open Cinema）/ Midnight Passion / Actors&apos;
            House / Community BIFF（官方编号 901–942）属第 1 批，其余（一般放映 / Master Class /
            Cine Class）属第 2 批。第 1 批 9/17 14:00、第 2 批 9/21 14:00（韩国时间）。
          </p>
        </div>
      )}
    </section>
  );
}
