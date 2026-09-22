// 「抢票」页(2026-09-15,`PLAN-20260915234414`;2026-09-16 改紧凑清单,`PLAN-20260916005951`)——
// 把**我的行程**里的场次按**开票批次**分组:第 1 批(9/17 14:00 KST)/ 第 2 批(9/21 14:00 KST)。
//
// ★ 为什么单开一页,而不是在「我的行程」里加个视图:
//   抢票当天真正要看的只有两件事 ——「这一批几点开」「我这一批要抢哪几场」;
//   行程页那套「按天分组 + 顺位卡」是**选片期**的视角,批次是**开票期**的视角,两者按日期分的并不是同一件事。
//
// ★ 为什么**不再复用 `ScreeningCard`**(2026-09-16 用户原话:「抢票和行程的 UI 重复太多了」):
//   场次卡是给「挑片 / 出门照着找地方」设计的(海报、豆瓣、时长、票价、徽章、GV 控件、冲突说明、
//   资料 / 定位 / 加入行程、同场人数) —— 这些在抢票页全是噪声。抢票当天要的只有**一行**:
//   哪个 CODE、几点、哪天、什么片、哪个馆、**第几顺位**。故本页自持一份清单行,只保留
//   「票务三态」这一处控件(`ScreeningTickets.tsx`,口径单一来源,不另写一份)。
//
// ★ 口径全部复用,不另起一套:
//   · 批次判据 = `batch.ts::ticketBatchOf`(**唯一来源**,分享文案的批次分节也用它,勿在此重判一次);
//   · 开票时间 / 节头 / 倒计时 = `extras.ts::ticketOpens` / `batchHeading` / `countdownText`
//     (与顶栏「距第 N 批开票」同源);
//   · 顺位 = `plans.rankOf`(行程页冲突组内**拖出来**的次序,本页不另算),
//     文案 = `share.ts::rankMark`(主选 / 备选②,与分享文案、分享图片**同一份措辞**);
//   · 日期 = `util.ts::dateInfo`(全站唯一日期写法,如 `OCT 8`);
//   · 起止时间 = 有效结束(`gv.ts::effEndMin` + `talkOnOf`,与网格 / 行程 / 分享一致);
//   · 影院 = `legend.ts::venueShort`(短名,与分享文案同一口径)。

import { useEffect, useState } from "react";
import { Link } from "../components/spectrum";
import { ScreeningTicketControl } from "../components/ScreeningTickets";
import { useCatalog } from "../app/store";
import { BATCH_CATEGORY_EN, groupCodesByBatch } from "../batch";
import { batchHeading, countdownText, extras, programOf, ticketOpens } from "../extras";
import { rankMark } from "../share";
import { store, tickets } from "../state";
import { actualCodeSet } from "../tickets";
import { dateInfo, filmInfoOf, fmtEndClock } from "../util";
import { effEndMin, talkOnOf } from "../gv";
import { venueShort } from "../legend";
import type { Screening } from "../types";
import "./rush.css";

/** 一行 = 一场要抢的场次。顺位取自行程的冲突组,**没有顺位(共同场次)就不印** —— 别兜底成「主选」。 */
function RushRow({ screening: s, rank }: { screening: Screening; rank: number | undefined }) {
  const { cat } = useCatalog();
  const venue = cat.venueById.get(s.venue_id);
  const mark = rankMark(rank);
  return (
    <li className="rush-row" data-screening={s.code}>
      <div className="rush-main">
        <span className="code">{s.code}</span>
        <time>
          {s.start_time.slice(0, 5)}–{fmtEndClock(effEndMin(s, talkOnOf(s.code)))}
        </time>
        <span className="rush-date">{dateInfo(s.date).label}</span>
        <span className="rush-title">
          {filmInfoOf(cat, s, store.mappings.get(s.code)).title}
        </span>
        <span className="rush-venue">{venue ? venueShort(venue) : s.venue_display}</span>
        {mark && (
          <span className="rush-rank" data-rank={rank}>
            {mark}
          </span>
        )}
      </div>
      <ScreeningTicketControl code={s.code} />
    </li>
  );
}

export function RushPage() {
  const { cat, codes, plans } = useCatalog();
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
      {/* 倒计时**只在批次卡里印**(见下) —— 摘要条再写一遍就是同一份数据两处印 */}
      <div className="summary-strip">
        <span>{total} 场待抢</span>
        <span title="票务状态标为「已抢到」的场次（含转票补入）">
          已抢到 {actual.size} 场
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
                <p className="rush-batch-meta">
                  <span>
                    {open
                      ? open.at > now
                        ? `还有 ${countdownText(open.at - now)} 开票`
                        : "已开票"
                      : "开票时间未收录，以官网为准"}
                  </span>
                  <span>
                    {group.screenings.length} 场{got ? ` · 已抢到 ${got} 场` : ""}
                  </span>
                </p>
                <p className="muted">{BATCH_CATEGORY_EN[group.batch]}</p>
                <ol className="rush-list">
                  {group.screenings.map((s) => (
                    <RushRow key={s.code} screening={s} rank={plans.rankOf.get(s.code)} />
                  ))}
                </ol>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
