import { useState } from "react";
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
  fmtEndClock,
  doubanScoreOf,
  hmsToMin,
} from "../util";
import { effEndMin, gvTalkMin, talkOnOf } from "../gv";
import {
  gvTalkMinOv,
  setGvTalk,
  setGvTalkMin,
  slotOf,
  store,
  toggleScreening,
} from "../state";
import { RATING_DEFS, SUBS_DEFS, subsKeys, venueShort } from "../legend";
import { BADGE_DEFS, screeningBadgeKeys } from "../badges";
import type { Screening } from "../types";

export function Badges({ screening: s }: { screening: Screening }) {
  const keys = screeningBadgeKeys(s);
  return (
    <span className="badges">
      {s.rating && (
        <span className="badge" title={RATING_DEFS[s.rating]?.zh}>
          {s.rating}
        </span>
      )}
      {subsKeys(s.subs).map((k) => (
        <span className="badge" key={k} title={SUBS_DEFS[k].zh}>
          {k}
        </span>
      ))}
      {keys.map((k) => (
        <span
          className="badge feature-badge"
          key={k}
          title={BADGE_DEFS.find((d) => d.key === k)?.title}
        >
          {BADGE_DEFS.find((d) => d.key === k)?.label ?? k}
        </span>
      ))}
      {s.page && <span className="badge">P{s.page}</span>}
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

export function GvControls({ screening: s }: { screening: Screening }) {
  const [session, setSession] = useState(0);
  return (
    <div className="gv-controls">
      <Checkbox
        isSelected={talkOnOf(s.code)}
        onChange={(on) => setGvTalk(s.code, on)}
      >
        参加映后谈
      </Checkbox>
      <DialogTrigger
        onOpenChange={(open) => {
          if (open) setSession((n) => n + 1);
        }}
      >
        <ActionButton aria-label={`调整 ${s.code} 映后时长`}>
          {gvTalkMin(s)} 分钟
        </ActionButton>
        <GvDurationDialog key={session} screening={s} />
      </DialogTrigger>
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
  slotFilter,
}: {
  screening: Screening;
  showTitle?: boolean;
  locate?: boolean;
  controls?: boolean;
  pickable?: boolean;
  wholeCard?: boolean;
  slotFilter?: ScheduleSelection;
}) {
  const { cat, conflicts } = useCatalog();
  const highlight = useHighlight();
  const { locateScreening } = useScheduleNavigation();
  const openFilm = useFilmNavigation();
  const picked = Boolean(slotOf(s.code));
  const info = filmInfoOf(cat, s, store.mappings.get(s.code));
  const score = doubanScoreOf(info.cats[0], store.mappings.get(s.code));
  const conflict = conflicts.get(s.date)?.codeSet.has(s.code);
  const venue = cat.venueById.get(s.venue_id);
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
        toggleScreening(filmNodeKey(cat, s), s.code);
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
          <span className="code">{s.code}</span>
          <time>
            {s.start_time.slice(0, 5)}–
            {fmtEndClock(effEndMin(s, talkOnOf(s.code)))}
          </time>
          <span>{venue ? venueShort(venue) : s.venue_display}</span>
        </div>
        {showTitle && <h3>{info.title}</h3>}
        <div className="screening-meta">
          <span>{s.duration_min} 分钟</span>
          <span className="screening-price" title="票价以 BIFF 官方价目表为准">
            {formatKrw(priceOf(s))}
          </span>
          {score && (
            <span className="score">豆瓣 {score.rating.toFixed(1)}</span>
          )}
          <Badges screening={s} />
        </div>
        {conflict && (
          <p className="conflict-label" title={conflictDescription}>
            时间重叠，需择一观看
            {conflictDescription ? `：${conflictDescription}` : ""}
          </p>
        )}
        <div className="inline-actions card-actions">
          {pickable && (
            <ActionButton
              aria-label={`${picked ? "移出" : "加入"}场次 ${s.code}`}
              onPress={() => toggleScreening(filmNodeKey(cat, s), s.code)}
            >
              {picked ? "移出行程" : "加入行程"}
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
