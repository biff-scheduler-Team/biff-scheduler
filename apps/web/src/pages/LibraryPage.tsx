import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import {
  ActionButton,
  Button,
  Picker,
  PickerItem,
  TextArea,
  ToastQueue,
} from "../components/spectrum";
import { FilterBar } from "../components/FilterBar";
import { QuerySearchField } from "../components/QuerySearchField";
import { ScreeningCard, useFilmNavigation } from "../components/ScreeningCard";
import { useCatalog } from "../app/store";
import { useFilters, useQuery } from "../app/hooks";
import { filmInUnit, libraryUnits, searchFilm, type FilmNode } from "../app/model";
import { setFilmExpanded, useLibraryExpansion } from "../app/library-state";
import { navSearch } from "../app/nav-query";
import { hasActiveFilter, LS_FILTERS_LIB, matchesFilters } from "../filters";
import { addPickFilm, removePick, setPickNote, soleShowCode, store } from "../state";
import {
  GO_SCHEDULE_LABEL,
  GO_VIEW_LABEL,
  SOLE_SHOW_HINT,
  UNWANT_LABEL,
  WANT_LABEL,
  WANT_TOAST,
  soleShowToast,
  unwantAria,
  unwantConfirm,
  wantAria,
  wantCountLabel,
} from "../actions-copy";
import { dateInfo, doubanScoreOf, doubanUrlOf, unitLabel } from "../util";
import { loadWantCounts, onWantCountsChange, peekWantCounts } from "../want-counts";

function FilmCard({
  film,
  pickedView,
  shows,
  open,
  onExpandedChange,
  wantCount,
}: {
  film: FilmNode;
  pickedView: boolean;
  shows: FilmNode["shows"];
  open: boolean;
  onExpandedChange: (open: boolean) => void;
  wantCount?: number;
}) {
  const { params, update } = useQuery();
  const openFilm = useFilmNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const entry = store.picks.get(film.key);
  // 只有一场的影片没有「挑场次」这一步:点一下就**直接落进行程**(2026-09-16,`PLAN-20260916004024`)。
  // 判据走 state 注入的 `soleShowCode()` —— 与移除口径同一份实现(注入点在 `store.tsx::hydrateStorage`)。
  // ⚠ 动作文案**不再按单场片分叉**(2026-09-20):两者都是「想看」这一个动作,
  //   副作用交给 `SOLE_SHOW_HINT` 悬停说明 + 成功提示解释,不靠换措辞暗示(见 `actions-copy.ts`)。
  const soleCode = soleShowCode(film.key);
  const score = doubanScoreOf(film.cats[0], film.map);
  // 豆瓣映射:取值链(有场次按 code、无场次按 `f###`)已由 `model.ts::buildFilms` 用
  // `util.ts::doubanMappingOf` 统一算进片节点 —— 这里不再各写一份回落(2026-09-17,`PLAN-20260917010426`)。
  const map = film.map;
  const gone = entry?.picks.filter((p) => !film.shows.some((s) => s.code === p.code)).length ?? 0;
  // 「另属」单元(2026 只有午夜联映块)—— 不显示的话,按午夜单元筛出来的片里
  // 会有 4 部卡片副标题写着别的单元,看着像筛错了(见 `model.ts::unitsOfFilm`)。
  const alsoUnits = film.cats[0]?.also_units ?? [];
  return (
    <article
      className="film-card"
      data-film-key={film.key}
      // 事件采集锚点（2026-09-20，第 3 轮）：与场次卡同一条理由 —— 只记「用了影片这一入口」
      data-track="film"
      tabIndex={-1}
    >
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
            {/* 主单元与「另属」单元同处一个 flex 项 —— `.film-unit` 是 space-between,
                拆成两个子项会把「联映」推到卡片中间去 */}
            <span>
              {unitLabel(film.cats[0]?.unit) || "特别节目"}
              {alsoUnits.length > 0 && (
                <span>
                  （联映 {alsoUnits.map((u) => unitLabel(u).replaceAll(" · ", "，")).join("、")}）
                </span>
              )}
            </span>
            {score && (
              <span className="score">豆瓣 {score.rating.toFixed(1)}</span>
            )}
            {typeof wantCount === "number" && wantCount > 0 && (
              <span className="want-count" data-want-count={wantCount}>
                {wantCountLabel(wantCount)}
              </span>
            )}
          </div>
          <div className="title-row">
            <h2>{film.zh}</h2>
            {/* 片名旁的豆瓣外跳(2026-09-13,PLAN-20260913184357):用户要的是「片名后面能直接点」,
                放在 <h2> **之外**做兄弟 —— 塞进标题会把标题的可访问名变成「片名 豆瓣 ↗」,
                读屏与 `getByRole("heading", { name, exact: true })` 都会跟着变吵。
                视觉与「我的行程」场次卡的同一个入口共用 `.douban-jump`(只此一处实现)。 */}
            <a
              className="douban-jump"
              href={doubanUrlOf(film, map)}
              target="_blank"
              rel="noopener noreferrer"
              title={map?.douban_url ? "在豆瓣打开这部片的条目页" : "未匹配豆瓣条目，将按片名搜索"}
            >
              豆瓣 ↗
            </a>
          </div>
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
              : // 单场片没有「挑场次」这一步 —— 把副作用写在片信息行里(手机没有悬停，见 `actions-copy.ts`)
                soleCode && !entry
                ? SOLE_SHOW_HINT
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
              if (addPickFilm(film.key, soleCode ?? undefined)) {
                ToastQueue.positive(soleShowToast(film.zh));
                return;
              }
              setFilmExpanded("picks", film.key, true);
              ToastQueue.positive(WANT_TOAST);
            }}
            aria-label={wantAria(film.zh)}
          >
            {WANT_LABEL}
          </Button>
        ) : !pickedView && film.shows.length > 0 && entry ? (
          <ActionButton
            onPress={() => {
              // 跨页去「我的选片」:查询串走 `nav-query` 口径 —— 本页的 `q` / `unit` 不跟过去,
              // 排片表的 `date` / `hour` 保留,最后再挂上要展开的那张卡。
              const p = new URLSearchParams(
                navSearch(location.search, location.pathname, "/picks"),
              );
              p.set("expand", film.key);
              setFilmExpanded("picks", film.key, true);
              navigate(`/picks?${p}`);
            }}
          >
            {/* 单场片加入即已排好场次 —— 再写「去排场次」会让人以为还差一步(2026-09-16) */}
            {soleCode && entry.picks.length > 0 ? GO_VIEW_LABEL : GO_SCHEDULE_LABEL}
          </ActionButton>
        ) : pickedView ? (
          <ActionButton
            aria-label={unwantAria(film.zh)}
            onPress={() => {
              const count = entry?.picks.length ?? 0;
              if (!window.confirm(unwantConfirm(film.title, count))) return;
              removePick(film.key);
            }}
          >
            {UNWANT_LABEL}
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
        <ActionButton
          aria-label={`${film.zh} 影片资料`}
          onPress={() => openFilm(film.key)}
        >
          资料
        </ActionButton>
        {/* 豆瓣入口不在这排按钮里(2026-09-13,PLAN-20260913184357):它挪到了上面的片名行
            (`.title-row` 里那个 `豆瓣 ↗`)。这排只留「对本卡做动作」的按钮,
            外跳链接夹在中间会显得像没做完。 */}
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
  const [wantCounts, setWantCounts] = useState(peekWantCounts);
  useEffect(() => {
    void loadWantCounts().then(setWantCounts);
    const stop = onWantCountsChange(() => setWantCounts({ ...peekWantCounts() }));
    return () => { stop(); };
  }, []);
  // 搜索词一变就把「显示更多」收回默认值。原来是写在搜索框的 onChange 里,现在搜索词由
  // `QuerySearchField` **延迟合并提交**,跟着已提交的 query 走才不会在打字中途反复重置。
  useEffect(() => {
    setLimit(40);
  }, [query]);
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
  // 日期随它最后一场排片一起消失 —— 与旧版选片器一致。
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
          {/* 显示值由 `QuerySearchField` 自己持有(URL 只当持久化出口),否则中文输入法的
              组合态会被 URL 那慢一拍的受控回写打断 —— 见 `app/query-search.ts`。 */}
          {!picked && <QuerySearchField
            label="搜索影片"
            placeholder="片名、导演、嘉宾或场次编号"
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
                wantCount={wantCounts[film.key]}
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
                // 直接点名按钮 —— 用户在这一页看到的第一个动作就是「想看」，别再让他猜是哪个入口
                ? `在影片库点「${WANT_LABEL}」把片子收进来，再挑选适合的场次。`
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
