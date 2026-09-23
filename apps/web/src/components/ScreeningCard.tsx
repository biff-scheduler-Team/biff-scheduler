import { useEffect, useId, useRef, useState } from "react";
import { Tooltip as BadgeTooltip, TooltipTrigger as BadgeTooltipTrigger, Popover, Dialog as AriaDialog } from "react-aria-components";
import { useScheduleNavigation } from "../app/navigation";
import { priceOf, formatKrw } from "../extras";
import { useHighlight } from "../app/highlight";
import { useFilmNavigation } from "../app/film-navigation";
export { useFilmNavigation } from "../app/film-navigation";
import type { ScheduleSelection } from "../app/schedule-selection";
import {
  ActionButton,
  Checkbox,
  Dialog,
  DialogTrigger,
  Heading,
  Content,
  NumberField,
  Button,
  ButtonGroup,
} from "./spectrum";
import { useCatalog } from "../app/store";
import {
  filmNodeKey,
  filmInfoOf,
  fmtDuration,
  fmtEndClock,
  doubanMappingOf,
  doubanScoreOf,
  doubanUrlOf,
  hmsToMin,
} from "../util";
import { effEndMin, gvTalkMin, talkOnOf } from "../gv";
import {
  gvTalkMinOv,
  setGvTalk,
  setGvTalkMin,
  slotOf,
  store,
} from "../state";
import { RATING_DEFS, SUBS_DEFS, mapsUrl, subsKeys, venuePlace, venueShort, venueTip } from "../legend";
import { BADGE_DEFS, screeningBadgeKeys, codeTip } from "../badges";
import { SameScreeningCount, ScreeningTicketControl } from "./ScreeningTickets";
import { SCHEDULE_LABEL, UNSCHEDULE_LABEL, scheduleAria } from "../actions-copy";
import { useScreeningPicker } from "./screening-actions";
import type { Screening } from "../types";

export function FilmBadge({ kind, label, title }: { kind: string; label: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  const description = title || (kind === "code" ? codeTip(label) : kind.startsWith("rating-") ? Object.values(RATING_DEFS).find(d => d.label === label)?.tip : kind.startsWith("subs-") ? Object.values(SUBS_DEFS).find(d => d.label === label)?.zh : BADGE_DEFS.find(d => d.key === kind)?.title) || label;
  const keepOpen = () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  const closeSoon = () => { keepOpen(); closeTimer.current = setTimeout(() => setOpen(false), 150); };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  return <BadgeTooltipTrigger isOpen={open} onOpenChange={setOpen} delay={0} closeDelay={150}><span ref={trigger} className="film-badge" data-badge={kind} title="" aria-description={description} aria-describedby={open ? id : undefined}
    onPointerEnter={() => {keepOpen();setOpen(true);}} onPointerLeave={closeSoon}>

    {kind === "batch" ? <svg viewBox="0 0 26 18" width="22" height="15" role="img" aria-label="Batch Screening 联映"><path d="M2 5v10M5 3v12M9 7h15v9H9zM9 2h15v5H9zM11 2l3 5m2-5 3 5m2-5 3 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg> : label}
  </span><BadgeTooltip triggerRef={trigger} placement="top" offset={6} className="film-badge-tooltip" onPointerEnter={keepOpen} onPointerLeave={closeSoon}><span id={id}>{description}</span></BadgeTooltip></BadgeTooltipTrigger>;
}

export function Badges({ screening: s }: { screening: Screening }) {
  const keys = screeningBadgeKeys(s);
  return (
    <span className="badges">
      {s.rating && (
        <FilmBadge kind={`rating-${s.rating}`} label={s.rating} title={RATING_DEFS[s.rating]?.tip} />
      )}
      {subsKeys(s.subs).map((k) => (
        <FilmBadge kind={`subs-${k}`} key={k} label={k} title={SUBS_DEFS[k].zh} />
      ))}
      {keys.map((k) => (
        <FilmBadge kind={k} key={k} label={BADGE_DEFS.find(d => d.key === k)?.label ?? k} title={BADGE_DEFS.find(d => d.key === k)?.title} />
      ))}
      {s.page && <FilmBadge kind="page" label={`P${s.page}`} title={`官方节目册第 ${s.page} 页`} />}
    </span>
  );
}

function GvDurationDialog({ screening: s }: { screening: Screening }) {
  const [value, setValue] = useState(
    () => gvTalkMinOv.get(s.code) ?? Number.NaN,
  );
  const defaultMinutes = store.settings.gvTalkMin;
  return (
    <Dialog size="S">
      {({ close }) => (
        <>
          <Heading slot="title">{s.code} 映后谈</Heading>
          <Content>
            <div className="form-stack">
              <NumberField
                label="本场映后时长（分钟）"
                description={`留空则跟随全局默认 ${defaultMinutes} 分钟。`}
                placeholder={String(defaultMinutes)}
                minValue={0}
                maxValue={240}
                value={value}
                onChange={setValue}
              />
              <ActionButton
                onPress={() => {
                  setGvTalkMin(s.code, null);
                  close();
                }}
              >
                跟随默认（{defaultMinutes} 分钟）
              </ActionButton>
            </div>
          </Content>
          <ButtonGroup>
            <Button variant="secondary" onPress={close}>
              取消
            </Button>
            <Button
              onPress={() => {
                setGvTalkMin(
                  s.code,
                  Number.isFinite(value)
                    ? Math.max(0, Math.round(value))
                    : null,
                );
                close();
              }}
            >
              保存映后时长
            </Button>
          </ButtonGroup>
        </>
      )}
    </Dialog>
  );
}

function GvPopoverForm({screening: s, close}: {screening: Screening; close: () => void}) {
  const [value, setValue] = useState(() => gvTalkMinOv.get(s.code) ?? Number.NaN);
  const defaults = store.settings.gvTalkMin;
  return <AriaDialog aria-label={`${s.code} 映后谈`} className="gv-popover-form">
    <h3>{s.code} 映后谈</h3>
    <NumberField label="本场映后时长（分钟）" description={`留空则跟随全局默认 ${defaults} 分钟。`} placeholder={String(defaults)} minValue={0} maxValue={240} value={value} onChange={setValue} autoFocus />
    <ActionButton onPress={() => {setGvTalkMin(s.code, null); close();}}>跟随默认（{defaults} 分钟）</ActionButton>
    <div className="preview-actions">
      <button className="preview-full" type="button" onClick={close}>取消</button>
      <button className="preview-full" type="button" onClick={() => {setGvTalkMin(s.code, Number.isFinite(value) ? Math.max(0, Math.round(value)) : null);close();}}>保存映后时长</button>
    </div>
  </AriaDialog>;
}

function GvDurationPopover({screening: s}: {screening: Screening}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" aria-label={`调整 ${s.code} 映后时长`} aria-haspopup="dialog" aria-expanded={open} onClick={() => {trigger.current?.focus({preventScroll: true});setOpen(value => !value);}}>
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 4 4 4M3 17l1-5L14 2a2.8 2.8 0 0 1 4 4L8 16l-5 1Z" /></svg>
    </button>
    <Popover triggerRef={trigger} isOpen={open} onOpenChange={setOpen} placement="top" offset={8} className="gv-duration-popover">
      <GvPopoverForm screening={s} close={() => setOpen(false)} />
    </Popover>
  </>;
}

export function GvDurationButton({ screening: s, iconOnly = false }: { screening: Screening; iconOnly?: boolean }) {
  const [session, setSession] = useState(0);
  if (iconOnly) return <GvDurationPopover screening={s} />;
  return (
    <DialogTrigger
      onOpenChange={(open) => {
        if (open) setSession((n) => n + 1);
      }}
    >
      <ActionButton aria-label={`调整 ${s.code} 映后时长`}>
        {iconOnly ? <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 4 4 4M3 17l1-5L14 2a2.8 2.8 0 0 1 4 4L8 16l-5 1Z" /></svg> : `${gvTalkMin(s)} 分钟`}
      </ActionButton>
      <GvDurationDialog key={session} screening={s} />
    </DialogTrigger>
  );
}

export function GvControls({ screening: s }: { screening: Screening }) {
  return (
    <div className="gv-controls">
      <Checkbox
        isSelected={talkOnOf(s.code)}
        onChange={(on) => setGvTalk(s.code, on)}
      >
        参加映后谈
      </Checkbox>
      <GvDurationButton screening={s} />
    </div>
  );
}

export function ScreeningCard({
  screening: s,
  showTitle = true,
  locate = false,
  controls = false,
  pickable = true,
  wholeCard = false,
  venueInfo = false,
  slotFilter,
  social = false,
}: {
  screening: Screening;
  showTitle?: boolean;
  locate?: boolean;
  controls?: boolean;
  pickable?: boolean;
  wholeCard?: boolean;
  /** 展开影院块(官方代码 + 影院全名 / 分区楼层 / 中韩文地址 + Google 地图入口)——
   *  「我的行程」出门时要照着找地方,故只在那里开;影片库里的场次行保持紧凑。 */
  venueInfo?: boolean;
  slotFilter?: ScheduleSelection;
  /** 行程页专用:票务三态 / 转票来源 / 同场人数(2026-09-14,PLAN-20260914164050)。
   *  刻意**不在影片库 / 排片网格上开** —— 那是「挑片」视图;票务结果只对已排进行程的场次有意义。
   *  ⚠ 原先这里还挂「讨论 N」:2026-09-21 先摘掉入口(`PLAN-20260921223658` 修订 1),
   *    2026-09-22 讨论区连同弹层整体下线(`PLAN-20260922101227`)。
   *    场次卡现在没有任何讨论相关的出口。 */
  social?: boolean;
}) {
  const { cat, conflicts } = useCatalog();
  // 点选 / 取消走共享出口:取消「只有一场」的影片要先提示会连选片一起移除(2026-09-16)
  const pickScreening = useScreeningPicker();
  const highlight = useHighlight();
  const { locateScreening } = useScheduleNavigation();
  const openFilm = useFilmNavigation();
  const picked = Boolean(slotOf(s.code));
  const info = filmInfoOf(cat, s, store.mappings.get(s.code));
  // 豆瓣映射取一次给三处用(评分 / 外跳 href / tooltip):有场次按 code、未命中退目录片 id ——
  // 与影片库卡、资料弹层同一口径(2026-09-17,`PLAN-20260917010426`)。
  const mapping = doubanMappingOf(store.mappings, { code: s.code, filmId: info.cats[0]?.id });
  const score = doubanScoreOf(info.cats[0], mapping);
  const conflict = conflicts.get(s.date)?.codeSet.has(s.code);
  const venue = cat.venueById.get(s.venue_id);
  const place = venuePlace(venue?.group);
  const inSelectedHour =
    slotFilter?.date === s.date && slotFilter.hour !== null
      ? hmsToMin(s.start_time) < (slotFilter.hour + 1) * 60 &&
        hmsToMin(s.end_time) > slotFilter.hour * 60
      : null;
  const slotHint =
    inSelectedHour && slotFilter
      ? `位于所选 ${fmtEndClock(slotFilter.hour! * 60)}–${fmtEndClock((slotFilter.hour! + 1) * 60)} 时段（时间筛选联动）`
      : undefined;
  const conflictDescription = conflicts
    .get(s.date)
    ?.pairs.filter((pair) => pair.includes(s.code))
    .map((pair) => pair.find((code) => code !== s.code)!)
    .map((code) => {
      const other = cat.byCode.get(code)!;
      const otherVenue = cat.venueById.get(other.venue_id);
      return `${code} ${filmInfoOf(cat, other, store.mappings.get(code)).title}，${other.start_time.slice(0, 5)}–${fmtEndClock(effEndMin(other, talkOnOf(code)))}，${otherVenue ? venueShort(otherVenue) : other.venue_display}`;
    })
    .join("；");
  return (
    <article
      className={`screening-card ${picked ? "selected" : ""} ${conflict ? "conflict" : ""} ${inSelectedHour === true ? "slot-hit" : inSelectedHour === false ? "hour-dim" : ""}`}
      data-screening={s.code}
      // 事件采集锚点（2026-09-20，第 3 轮）：整卡一刀，卡内任何点击都算「用了场次这一入口」。
      // 只埋一类事件、不带场次 code —— 计数型的价值在「入口热不热」，细到场次会把表撑成 800 行长尾。
      data-track="screening"
      data-hour-match={inSelectedHour ?? undefined}
      title={slotHint}
      aria-description={slotHint}
      data-whole-card={wholeCard || undefined}
      onClick={(event) => {
        if (
          !wholeCard ||
          !pickable ||
          !event.currentTarget.contains(event.target as Node) ||
          (event.target as HTMLElement).closest(
            'button,a,input,label,select,textarea,[role="button"]',
          )
        )
          return;
        pickScreening(s);
      }}
      data-highlighted={highlight.codes.has(s.code) || undefined}
      onMouseEnter={() => highlight.setCode(s.code)}
      onMouseLeave={() => highlight.setCode(null)}
    >
      {showTitle && info.cats[0]?.poster && (
        <img
          className="screening-poster"
          src={info.cats[0].poster}
          alt=""
          loading="lazy"
        />
      )}
      <div className="screening-content">
        <div className="screening-meta">
          <FilmBadge kind="code" label={s.code} />
          <time>
            {s.start_time.slice(0, 5)}–
            {fmtEndClock(effEndMin(s, talkOnOf(s.code)))}
          </time>
          {/* 开了影院块就不再在这里重复影院名(下方那块带代码 / 地址 / 地图入口,信息更全) */}
          {!venueInfo && <span>{venue ? venueShort(venue) : s.venue_display}</span>}
        </div>
        {showTitle && (
          <div className="title-row">
            <h3>{info.title}</h3>
            {/* 片名旁的豆瓣跳转(2026-09-13,PLAN-20260913184357):「我的行程」是出门前
                真正在用的视图,查影评 / 看简介要一步到位,所以入口贴片名而不是埋在底部操作行。
                `↗` 与本卡「在 Google 地图打开 ↗」同一套外跳视觉。
                ⚠ 放在 <h3> 之外做兄弟:塞进标题会把标题的 accessible name 变成
                「片名 豆瓣 ↗」,让 `getByRole("heading", { name, exact: true })` 一类断言漂移。 */}
            <a
              className="douban-jump"
              href={doubanUrlOf(info, mapping)}
              target="_blank"
              rel="noopener noreferrer"
              title={
                mapping?.douban_url
                  ? "在豆瓣打开这部片的条目页"
                  : "未匹配豆瓣条目，将按片名搜索"
              }
            >
              豆瓣 ↗
            </a>
          </div>
        )}
        <div className="screening-meta">
          <span>{fmtDuration(s.duration_min)}</span>
          <span className="screening-price" title="票价以 BIFF 官方价目表为准">
            {formatKrw(priceOf(s))}
          </span>
          {score && (
            <span className="score">豆瓣 {score.rating.toFixed(1)}</span>
          )}
          <Badges screening={s} />
          {social && <SameScreeningCount code={s.code} />}
        </div>
        {venueInfo && (venue || s.venue_display) && (
          <div className="screening-venue" title={venue ? venueTip(venue) : undefined}>
            <div className="screening-venue-head">
              {venue && (
                /* 加「影院」前缀:与卡片顶部的场次代码徽章(001)同为小代码块,不加前缀容易混 */
                <span className="code venue-code" title="影院代码">
                  影院 {venue.code ?? venue.id.toUpperCase()}
                </span>
              )}
              <strong>{venue ? venueShort(venue) : s.venue_display}</strong>
              {place && (
                <span className="venue-place-row">
                  <span className="venue-place-name">
                    {place.name}
                    {place.nameZh && place.nameZh !== place.name
                      ? ` · ${place.nameZh}`
                      : ""}
                  </span>
                  <a
                    className="venue-map-link"
                    href={mapsUrl(place)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`在 Google 地图打开 —— 手机点按会直接唤起 Google Maps 导航\n${place.name}\n${place.address}\n${place.addressKr}`}
                  >
                    在 Google 地图打开 ↗
                  </a>
                </span>
              )}
            </div>
          </div>
        )}
        {conflict && (
          <p className="conflict-label" title={conflictDescription}>
            时间重叠，需择一观看
            {conflictDescription ? `：${conflictDescription}` : ""}
          </p>
        )}
        {social && <ScreeningTicketControl code={s.code} />}
        <div className="inline-actions card-actions">
          {pickable && (
            <ActionButton
              aria-label={scheduleAria(picked, s.code)}
              onPress={() => pickScreening(s)}
            >
              {picked ? UNSCHEDULE_LABEL : SCHEDULE_LABEL}
            </ActionButton>
          )}
          <ActionButton
            aria-label={`场次 ${s.code} 影片资料`}
            onPress={() => openFilm(filmNodeKey(cat, s), s.code)}
          >
            资料
          </ActionButton>
          {locate && (
            <ActionButton
              aria-label={`定位场次 ${s.code}`}
              onPress={() => locateScreening(s.code)}
            >
              定位
            </ActionButton>
          )}
        </div>
        {controls && s.is_gv && <GvControls screening={s} />}
      </div>
    </article>
  );
}
