import { useDeferredValue, useLayoutEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import {
  ActionButton,
  Button,
  SearchField,
  Picker,
  PickerItem,
  Link,
  TextArea,
  ToastQueue,
} from "../components/spectrum";
import { FilterBar } from "../components/FilterBar";
import { ScreeningCard, useFilmNavigation } from "../components/ScreeningCard";
import { useCatalog } from "../app/store";
import { useFilters, useQuery } from "../app/hooks";
import { filmInUnit, libraryUnits, searchFilm, type FilmNode } from "../app/model";
import { setFilmExpanded, useLibraryExpansion } from "../app/library-state";
import { hasActiveFilter, LS_FILTERS_LIB, matchesFilters } from "../filters";
import { addPickFilm, removePick, setPickNote, store } from "../state";
import { dateInfo, doubanScoreOf, unitLabel } from "../util";

function FilmCard({
  film,
  pickedView,
  shows,
  open,
  onExpandedChange,
}: {
  film: FilmNode;
  pickedView: boolean;
  shows: FilmNode["shows"];
  open: boolean;
  onExpandedChange: (open: boolean) => void;
}) {
  const { params, update } = useQuery();
  const openFilm = useFilmNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const entry = store.picks.get(film.key);
  const score = doubanScoreOf(film.cats[0], film.map);
  const direct = film.map?.douban_url ?? store.mappings.get(film.cats[0]?.id ?? "")?.douban_url;
  const gone = entry?.picks.filter((p) => !film.shows.some((s) => s.code === p.code)).length ?? 0;
  return (
    <article className="film-card" data-film-key={film.key} tabIndex={-1}>
      <div className="film-heading">
        {film.poster && (
          <img
            className="film-poster"
            src={film.poster}
            loading="lazy"
            alt=""
          />
        )}
        <div className="film-heading-text">
          <div className="film-unit">
            {unitLabel(film.cats[0]?.unit) || "特别节目"}
            {score && (
              <span className="score">豆瓣 {score.rating.toFixed(1)}</span>
            )}
          </div>
          <h2>{film.zh}</h2>
          {film.en !== film.zh && <p className="film-en">{film.en}</p>}
          {film.names.length > 0 && <p className="muted">{film.names.join(" / ")}</p>}
          {film.meta && (
            <p className="muted film-meta">
              {film.meta.replaceAll(" · ", "，")}
            </p>
          )}
          <p className="muted">
            {film.block
              ? "收录于合集"
              : film.shows.length
                ? `共 ${film.shows.length} 场`
                : "暂无排期"}
            {/* 0 场写「未排场」而不是「已排 0 场」:移出行程后片仍在选片里(2026-09-13,
                PLAN-20260913180837),这行是用户唯一能看出「片没丢、只是没排场」的地方,
                说法与帮助弹层里的「标注『未排场』」逐字对齐。 */}
            {entry && (entry.picks.length ? `，已排 ${entry.picks.length} 场` : "，未排场")}
          </p>
        </div>
      </div>
      <div className="inline-actions film-actions">
        {!pickedView && film.shows.length > 0 && !entry ? (
          <Button
            variant="primary"
            onPress={() => {
              addPickFilm(film.key);
              setFilmExpanded("picks", film.key, true);
              ToastQueue.positive("已加入我的选片，可以在那里挑选场次。");
            }}
            aria-label={`加入我的选片 ${film.zh}`}
          >
            加入我的选片
          </Button>
        ) : !pickedView && film.shows.length > 0 && entry ? (
          <ActionButton
            onPress={() => {
              const p = new URLSearchParams(location.search);
              p.set("expand", film.key);
              p.delete("pickDate");
              setFilmExpanded("picks", film.key, true);
              navigate(`/picks?${p}`);
            }}
          >
            已在选片，去排场次
          </ActionButton>
        ) : pickedView ? (
          <ActionButton
            aria-label={`移除影片 ${film.zh}`}
            onPress={() => {
              const count = entry?.picks.length ?? 0;
              if (count && !window.confirm(`《${film.title}》已排 ${count} 场，确定整片移除（含这些场次）？`)) return;
              removePick(film.key);
            }}
          >
            移除影片
          </ActionButton>
        ) : null}
        <ActionButton
          aria-label={`${open ? "收起" : "展开"} ${film.zh} 场次`}
          aria-expanded={open}
          onPress={() => {
            onExpandedChange(!open);
            if (params.has("expand")) update({ expand: null }, true);
          }}
        >
          {open ? "收起场次" : "查看场次"}
        </ActionButton>
        <Link
          href={direct || `https://www.douban.com/search?q=${encodeURIComponent((film.en || film.zh).trim())}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {direct ? "豆瓣" : "豆瓣搜索"}
        </Link>
        <ActionButton
          aria-label={`${film.zh} 影片资料`}
          onPress={() => openFilm(film.key)}
        >
          资料
        </ActionButton>
      </div>
      {pickedView && entry && (
        <div className="film-note">
          <TextArea
            label={`${film.zh} 备注`}
            value={entry.note}
            onChange={(note) => setPickNote(film.key, note)}
          />
        </div>
      )}
      {open && (
        <div className="film-screenings">
          {film.block && (
            <p className="muted">
              收录于 {film.block.title_en}，选场后按整张合集票计入行程。
            </p>
          )}
          {shows.length === 0 && (
            <p className="empty-inline">
              {film.shows.length || film.block
                ? "当前筛选下没有场次。"
                : "排期尚未发布。"}
            </p>
          )}
          {shows.map((s, i) => (
            <div key={s.code}>
              {i === 0 || shows[i - 1].date !== s.date ? (
                <h3 className="date-divider">
                  {dateInfo(s.date).label} {dateInfo(s.date).weekday}
                </h3>
              ) : null}
              <ScreeningCard
                screening={s}
                showTitle={false}
                locate
                controls={pickedView}
                pickable={pickedView}
              />
            </div>
          ))}
          {pickedView && gone > 0 && (
            <p className="notice">另有 {gone} 场已排场次不在当前排期里（数据换版）</p>
          )}
        </div>
      )}
    </article>
  );
}

export function LibraryPage({ picked = false }: { picked?: boolean }) {
  const { cat, films } = useCatalog();
  const navigate = useNavigate();
  const { params, update } = useQuery();
  const { filters, update: updateFilters } = useFilters(LS_FILTERS_LIB);
  const query = useDeferredValue(picked ? "" : params.get("q") ?? "");
  const unit = picked ? "all" : params.get("unit") ?? "all";
  const tab = picked ? "picks" : "library";
  const expanded = useLibraryExpansion(tab);
  const targetKey = picked ? params.get("expand") : null;
  const listRef = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(40);
  const units = libraryUnits(cat.films);
  const candidates = films.filter(
    (f) =>
      (!picked || (store.picks.has(f.key) && f.shows.length > 0)) &&
      searchFilm(f, query) &&
      (unit === "all" || filmInUnit(f, unit)),
  );
  const available = candidates.map((film) => ({
      film,
      shows: film.shows.filter((s) => matchesFilters(s, filters)),
    }));
  const dateCounts = new Map<string, number>();
  for (const { shows } of available) for (const s of shows) {
    dateCounts.set(s.date, (dateCounts.get(s.date) ?? 0) + 1);
  }
  const dates = [...dateCounts.keys()].sort();
  // Stale dates disappear with their last available screening, as in the old picker.
  const selectedDates = picked
    ? (params.get("pickDate") ?? "").split(",").filter((d) => dateCounts.has(d))
    : [];
  const matching = available
    .filter(({ shows }) => picked
      ? selectedDates.length === 0 || shows.some((s) => selectedDates.includes(s.date))
      : !hasActiveFilter(filters) || shows.length > 0)
    .map(({ film, shows }) => ({
      film,
      shows: picked
        ? shows.filter((s) => !selectedDates.length || selectedDates.includes(s.date))
        : shows.length || !film.block ? shows : [film.block],
    }));
  const targetIndex = targetKey ? matching.findIndex(({ film }) => film.key === targetKey) : -1;
  const visibleLimit = Math.max(limit, targetIndex + 1);
  const selectedDateKey = selectedDates.join(",");
  const rawDates = params.get("pickDate");
  useLayoutEffect(() => {
    if (picked && rawDates && rawDates !== selectedDateKey) update({ pickDate: selectedDateKey || null }, true);
  }, [picked, rawDates, selectedDateKey, update]);
  useLayoutEffect(() => {
    if (!targetKey || targetIndex < 0) return;
    const card = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-film-key]") ?? [])
      .find((node) => node.dataset.filmKey === targetKey);
    if (!card) return;
    setFilmExpanded("picks", targetKey, true);
    const panel = card.closest<HTMLElement>(".side-panel");
    if (panel && getComputedStyle(panel).overflowY !== "visible") {
      panel.scrollTop = Math.max(0, card.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - (panel.querySelector<HTMLElement>(".viewing-panel-heading")?.offsetHeight ?? 0));
    } else {
      window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY, behavior: "instant" });
    }
    card.focus({ preventScroll: true });
  }, [targetKey, targetIndex]);
  return (
    <>
      <section
        className="library-page"
        aria-label={picked ? "我的选片" : "影片库"}
      >
        <div className="panel-heading">
          <div>
            <p className="eyebrow">
              {picked
                ? "选好电影，再安排时间"
                : `${cat.schedule.festival.year} 釜山国际电影节`}
            </p>
            <h1>{picked ? "我的选片" : "影片库"}</h1>
          </div>
          <span className="count" aria-live="polite">
            {matching.length} 部
          </span>
        </div>
        <div className="library-controls">
          {!picked && <SearchField
            label="搜索影片"
            placeholder="片名、导演、嘉宾或场次编号"
            value={params.get("q") ?? ""}
            onChange={(q) => {
              update({ q }, true);
              setLimit(40);
            }}
          />}
          <div className="inline-fields">
            {!picked && <Picker
              label="单元"
              value={unit}
              onChange={(v) => {
                update({ unit: v === "all" ? null : String(v) });
                setLimit(40);
              }}
            >
              <PickerItem id="all">全部单元</PickerItem>
              {units.map((u) => (
                <PickerItem id={u.key} key={u.key}>
                  {`${u.label.replaceAll(" · ", "，")}，${u.count} 部`}
                </PickerItem>
              ))}
            </Picker>}
            {picked && dates.length > 1 && (
              <Picker
                label="选片日期"
                selectionMode="multiple"
                placeholder="全部日期"
                value={selectedDates}
                onChange={(values) => update({ pickDate: values.length ? values.map(String).sort().join(",") : null })}
              >
                {dates.map((d) => (
                  <PickerItem id={d} key={d}>
                    {`${dateInfo(d).label} ${dateInfo(d).weekday}，${dateCounts.get(d)} 场`}
                  </PickerItem>
                ))}
              </Picker>
            )}
            {picked && selectedDates.length > 0 && <ActionButton onPress={() => update({ pickDate: null })}>全部日期</ActionButton>}
          </div>
          <FilterBar
            filters={filters}
            onChange={updateFilters}
            label="影片库筛选"
          />
        </div>
        {matching.length ? (
          <div className="film-list" ref={listRef}>
            {matching.slice(0, visibleLimit).map(({ film, shows }) => (
              <FilmCard
                film={film}
                key={film.key}
                pickedView={picked}
                shows={shows}
                open={expanded.has(film.key) || film.key === targetKey || (!picked && query.trim() !== "")}
                onExpandedChange={(open) => setFilmExpanded(tab, film.key, open)}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <h2>
              {picked && !store.picks.size
                ? "从一部想看的电影开始"
                : "没有符合条件的影片"}
            </h2>
            <p>
              {picked && !store.picks.size
                ? "在影片库加入想看的电影，再挑选适合的场次。"
                : "试试其他片名，或清除筛选。"}
            </p>
            {picked && !store.picks.size && (
              <Button onPress={() => navigate("/library")}>影片库</Button>
            )}
          </div>
        )}
        {matching.length > visibleLimit && (
          <div className="load-more">
            <ActionButton onPress={() => setLimit(visibleLimit + 40)}>
              显示更多（剩余 {matching.length - visibleLimit} 部）
            </ActionButton>
          </div>
        )}
      </section>
      <Outlet />
    </>
  );
}
