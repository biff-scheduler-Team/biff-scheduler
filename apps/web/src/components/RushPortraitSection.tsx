// 分析页 · B 组「我的观影画像」（2026-09-20，第 2 轮，PLAN-20260920203010 修订 1）。
//
// ★ 这是本页唯一的**个人视角**分组：上面几组都在说全站，这一组只说「我」。
//   它的价值是让人在开票前发现「我自己排得不合理」（单日过密 / 只挑一个单元 / 预算超了）。
//
// ⚠ 行程为空 → **整组不渲染**（`buildPortrait` 返回 null）：一份全 0 的画像不是信息。

import { allCodes } from "../state";
import type { ChartTokens } from "../chart-theme";
import { formatKrw, priceOf } from "../extras";
import { venueShort } from "../legend";
import { buildPortrait, type MyShowRow } from "../rush-portrait";
import { startHourOf } from "../rush-analysis";
import type { Catalog } from "../types";
import type { FilmNode } from "../app/model";
import { dateInfo, filmNodeKey, unitLabel } from "../util";
import { CountBarChart, RankBarChart } from "./charts/bars";

/** 品牌 / 单元榜的截断长度：榜单要能一眼看完，不是让人翻页。 */
const TOP_GROUPS = 8;

export function RushPortraitSection({
  cat,
  films,
  tokens,
}: {
  cat: Catalog;
  films: FilmNode[];
  tokens: ChartTokens;
}) {
  const filmByKey = new Map(films.map((film) => [film.key, film]));
  const myRows: MyShowRow[] = [];
  for (const code of allCodes()) {
    const screening = cat.byCode.get(code);
    if (!screening) continue; // 换版残留的 code：排期里已经没有它了
    const hour = startHourOf(screening.start_time);
    if (hour === null) continue;
    const key = filmNodeKey(cat, screening);
    const film = filmByKey.get(key);
    const item = film?.cats[0];
    const venue = cat.venueById.get(screening.venue_id);
    myRows.push({
      code,
      filmKey: key,
      date: screening.date,
      startHour: hour,
      durationMin: screening.duration_min,
      priceKrw: priceOf(screening),
      venueId: screening.venue_id,
      venueGroup: venue?.group ?? "",
      venueLabel: venue ? venueShort(venue) : screening.venue_display,
      unit: unitLabel(item?.unit ?? film?.cats[0]?.unit ?? ""),
      country: item?.country ?? "",
      rating: item?.rating ?? null,
    });
  }

  const portrait = buildPortrait(myRows);
  if (!portrait) return null;

  return (
    <section className="ra-block" aria-label="我的观影画像" data-my-shows={portrait.shows}>
      <h2>我的观影画像</h2>
      <p
        className="ra-hint"
        title="不评价好坏，只把「我这届是怎么排的」摆出来 —— 单日过密、只挑一个单元这类问题看一眼就能发现。"
      >
        我自己的行程是什么样（规模 / 时间 / 偏好 / 花费）。
      </p>

      <div className="ra-metrics">
        <div className="ra-metric">
          <b>{portrait.films}</b>
          <span>影片 · {portrait.shows} 场</span>
        </div>
        <div className="ra-metric">
          <b>{portrait.days}</b>
          <span>覆盖天数（平均每日 {portrait.avgPerDay.toFixed(1)} 场）</span>
        </div>
        <div className="ra-metric">
          <b>{portrait.venues}</b>
          <span>覆盖影厅</span>
        </div>
        <div className="ra-metric">
          <b>{Math.round(portrait.minutes / 60)}</b>
          <span>小时（{portrait.minutes} 分钟）</span>
        </div>
        <div className="ra-metric">
          <b>{formatKrw(portrait.priceKrw)}</b>
          <span>票面总额</span>
        </div>
        <div className="ra-metric">
          <b>{portrait.rated === null ? "—" : portrait.rated.average.toFixed(1)}</b>
          <span>已选影片平均豆瓣分（{portrait.rated?.count ?? 0} 部有分）</span>
        </div>
      </div>

      <p
        className="ra-hint"
        title="票面总额按票价档位 × 场次数计算，不含会员折扣与套票，不等于实付金额。"
      >
        {portrait.busiest === null
          ? "还没有排任何场次。"
          : `最满的一天 ${dateInfo(portrait.busiest.date).label}（${portrait.busiest.shows} 场）；票面总额不含折扣。`}
      </p>
      {/* 制产国也走横排图（原先是一行拼接文字 —— 那是最难读的一种「占比」表达） */}
      {portrait.byCountry.length > 0 && (
        <RankBarChart
          chart="portrait-countries"
          label="我的选片按制产国分布"
          valueName="我的场次"
          data={portrait.byCountry
            .slice(0, TOP_GROUPS)
            .map((item) => ({ label: item.label, value: item.shows }))}
          tokens={tokens}
          footnote="合拍片会同时计给每个国家，故合计可能超过总场次。"
        />
      )}

      <div className="ra-grid">
        <CountBarChart
          chart="portrait-by-date"
          label="我的场次按日期分布"
          valueName="我的场次"
          data={portrait.byDate.map((bucket) => ({ label: dateInfo(bucket.date).label, value: bucket.shows }))}
          tokens={tokens}
          footnote="只看我排进行程的场次；哪天柱子最高，那天就是最需要留体力的。"
        />
        <CountBarChart
          chart="portrait-by-hour"
          label="我的场次按开场时段分布"
          valueName="我的场次"
          data={portrait.byHour.map((bucket) => ({ label: bucket.label, value: bucket.shows }))}
          tokens={tokens}
          footnote="跨午夜场归入「次日」档，不对 24 取模。"
        />
      </div>

      <div className="ra-grid">
        <RankBarChart
          chart="portrait-units"
          label="我的选片按单元分布"
          valueName="我的场次"
          data={portrait.byUnit.slice(0, TOP_GROUPS).map((item) => ({ label: item.label, value: item.shows }))}
          tokens={tokens}
          footnote="只列场次最多的几个单元 —— 全挤在一个单元时，说明别的单元还没翻过。"
        />
        <RankBarChart
          chart="portrait-venues"
          label="我的场次按影院品牌分布"
          valueName="我的场次"
          data={portrait.byVenueGroup
            .slice(0, TOP_GROUPS)
            .map((item) => ({ label: item.label, value: item.shows }))}
          tokens={tokens}
          footnote="跨影院转场有路上时间成本（转场缓冲可在设置里调），集中在同一品牌会轻松很多。"
        />
      </div>

    </section>
  );
}
