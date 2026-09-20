// 分析页 · ②「我的观影画像 / 影片分析」（2026-09-20 精简版）。
//
// ★ 两块**刻意分开**（用户把两者写在一起，但它们的口径完全不同）：
//   · 我的观影画像 —— 只数**我排进行程**的场次（国家 / 单元 / 影院 / 时间 / 花费）；
//   · 影片分析 —— 数**本届全部片目**（国家 / 单元 / 年份 / 评分 / 时长），与我看没看无关。
//   两块用同一套图表，但标题与图注都写明「我的 N 场」还是「本届 N 部」——
//   混在一起就会让人把「我选了 12 部韩国片」读成「本届有 12 部韩国片」。
//
// ⚠ 「类型（genre）」不在产物里（官方册子与豆瓣映射都没这一列），故这一组用**单元**替代。
//   要用真类型得回抓豆瓣条目页 —— 见交付说明。

import { useMemo } from "react";
import type { ChartTokens } from "../chart-theme";
import { useCatalog } from "../app/store";
import { allCodes } from "../state";
import { formatKrw, priceOf } from "../extras";
import { venueShort } from "../legend";
import { startHourOf } from "../rush-analysis";
import { buildPortrait, filmFacets, type FilmFacetRow, type MyShowRow } from "../rush-portrait";
import { dateInfo, filmNodeKey, unitLabel } from "../util";
import { DonutChart, RankBarChart } from "./charts/bars";
import { CountBarChart } from "./charts/bars";

/** 环形图最多分几类 —— 再多图例就比环还长了（其余合并成「其他」由调用方决定，这里只截断）。 */
const TOP_FACETS = 7;
/** 每行的行高（横排榜） */
const ROW_H = 22;
/** 年份榜最多列几个 —— 见使用处的说明（全列会成为一条「根根皆针」的纵轴）。 */
const YEAR_ROWS = 8;

export function RushPortraitPanel({ tokens }: { tokens: ChartTokens }) {
  const { cat, films } = useCatalog();

  /* ---------- 我的：行程装配 ---------- */
  const myRows: MyShowRow[] = [];
  for (const code of allCodes()) {
    const screening = cat.byCode.get(code);
    if (!screening) continue;
    const hour = startHourOf(screening.start_time);
    if (hour === null) continue;
    const key = filmNodeKey(cat, screening);
    const item = films.find((film) => film.key === key)?.cats[0];
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
      unit: unitLabel(item?.unit ?? ""),
      country: item?.country ?? "",
      rating: item?.rating ?? null,
    });
  }
  const portrait = buildPortrait(myRows);

  /* ---------- 影片分析：全站片目装配 ---------- */
  const facets = useMemo(() => {
    const rows: FilmFacetRow[] = films.map((film) => {
      const item = film.cats[0];
      return {
        key: film.key,
        title: film.title,
        unit: unitLabel(item?.unit ?? ""),
        country: item?.country ?? "",
        year: typeof item?.year === "number" ? item.year : null,
        rating: typeof item?.rating === "number" ? item.rating : null,
        durationMin: typeof item?.duration_min === "number" ? item.duration_min : null,
      };
    });
    return filmFacets(rows);
  }, [films]);

  const slice = <T,>(list: T[]): T[] => list.slice(0, TOP_FACETS);

  // 年份榜只留「影片数最多的前 YEAR_ROWS 个」，但**显示时按年份升序**（时间轴语义不丢）
  const yearTop = [...facets.byYear]
    .sort((a, b) => b.films - a.films || a.label.localeCompare(b.label))
    .slice(0, YEAR_ROWS)
    .sort((a, b) => a.label.localeCompare(b.label));
  const yearRest = facets.byYear.reduce((sum, item) => sum + item.films, 0) - yearTop.reduce((sum, item) => sum + item.films, 0);

  return (
    <>
      {portrait && (
        <section
          className="ra-block"
          aria-label="我的观影画像"
          data-my-shows={portrait.shows}
          data-my-films={portrait.films}
        >
          <h2>我的观影画像</h2>
          <p
            className="ra-hint"
            title="票面总额按票价档位 × 场次数计算，不含会员折扣与套票，不等于实付金额。"
          >
            我排进行程的 {portrait.films} 部片 / {portrait.shows} 场（票面总额不含折扣）。
          </p>

          <div className="ra-metrics">
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
              <span>已选影片平均分（{portrait.rated?.count ?? 0} 部有分）</span>
            </div>
            <div className="ra-metric">
              <b>{portrait.busiest ? portrait.busiest.shows : 0}</b>
              <span>最满一天（{portrait.busiest ? dateInfo(portrait.busiest.date).label : "—"}）</span>
            </div>
          </div>

          <div className="ra-grid">
            <DonutChart
              chart="portrait-country"
              label="我的场次 · 制产国"
              data={slice(portrait.byCountry).map((item) => ({ name: item.label, value: item.shows }))}
              tokens={tokens}
              centerLabel={String(portrait.shows)}
              footnote="合拍片会同时计给每个国家，故合计可能大于总场次。"
            />
            <DonutChart
              chart="portrait-unit"
              label="我的场次 · 单元"
              data={slice(portrait.byUnit).map((item) => ({ name: item.label, value: item.shows }))}
              tokens={tokens}
              centerLabel={String(portrait.shows)}
              footnote="单元是官方片单的分类（相当于「类型」的替代口径 —— 产物里没有 genre 这一列）。"
            />
            <RankBarChart
              chart="portrait-venue"
              label="我的场次 · 影院"
              valueName="我的场次"
              data={slice(portrait.byVenueGroup).map((item) => ({ label: item.label, value: item.shows }))}
              tokens={tokens}
              rowHeight={ROW_H}
              footnote="跨影院要留转场时间（转场缓冲可在设置里调）。"
            />
          </div>
          <CountBarChart
            chart="portrait-date"
            label="我的场次 · 日期"
            valueName="我的场次"
            data={portrait.byDate.map((item) => ({
              label: dateInfo(item.date).label,
              value: item.shows,
            }))}
            tokens={tokens}
            height={200}
            footnote="柱子最高的那天最需要留体力。"
          />
        </section>
      )}

      <section className="ra-block" aria-label="影片分析" data-facet-films={facets.films}>
        <h2>影片分析</h2>
        <p className="ra-hint" title="这里数的是**本届全部片目**，与我看没看无关；我的行程构成见上一组。">
          本届 {facets.films} 部片目的构成（按<strong>国家 / 单元 / 年份 / 评分 / 时长</strong>）。
        </p>

        {/* 三张占比环一行（各占 1/3，铺满） */}
        <div className="ra-grid">
          <DonutChart
            chart="facet-country"
            label="本届片目 · 制产国"
            data={slice(facets.byCountry).map((item) => ({ name: item.label, value: item.films }))}
            tokens={tokens}
            centerLabel={String(facets.films)}
            footnote="合拍片会同时计给每个国家，故合计可能大于片目总数。"
          />
          <DonutChart
            chart="facet-unit"
            label="本届片目 · 单元"
            data={slice(facets.byUnit).map((item) => ({ name: item.label, value: item.films }))}
            tokens={tokens}
            centerLabel={String(facets.films)}
            footnote="「类型（genre）」暂缺：产物里没有这一列，单元是最近的口径。"
          />
          <DonutChart
            chart="facet-rating"
            label="本届片目 · 豆瓣评分分档"
            data={facets.byRating.map((item) => ({ name: item.label, value: item.films }))}
            tokens={tokens}
            centerLabel={String(facets.films)}
            footnote="无评分的片子单列一档 —— 不是 0 分。"
          />
        </div>
        {/* 两张排行一行（各占一半，铺满）。
            ⚠ 年份**只列影片数最多的前 8 个**：本届有 28 个年份，全列出来是一条根根皆针的
              纵轴（2026-09-20 截图实测：占满一整列高度，信息量却接近 0）。 */}
        <div className="ra-grid">
          <RankBarChart
            chart="facet-year"
            label="本届片目 · 年份"
            valueName="影片数"
            data={yearTop.map((item) => ({ label: item.label, value: item.films }))}
            tokens={tokens}
            rowHeight={ROW_H}
            footnote={
              facets.byYear.length > yearTop.length
                ? `共 ${facets.byYear.length} 个年份，只列影片数最多的 ${yearTop.length} 个（其余 ${facets.byYear.length - yearTop.length} 个年份合计 ${yearRest} 部）。老片重映与新片首映的比例，能看出这一届的选片取向。`
                : "老片重映与新片首映的比例，能看出这一届的选片取向。"
            }
          />
          <RankBarChart
            chart="facet-duration"
            label="本届片目 · 时长分档"
            valueName="影片数"
            data={facets.byDuration.map((item) => ({ label: item.label, value: item.films }))}
            tokens={tokens}
            rowHeight={ROW_H}
            footnote="时长决定一天能排几场 —— 它和「我的场次」那组一起看才有意义。"
          />
        </div>
      </section>
    </>
  );
}
