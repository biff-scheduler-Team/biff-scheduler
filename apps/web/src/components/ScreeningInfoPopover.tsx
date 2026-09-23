import {ScreeningMemberList} from './ScreeningMemberList';
import {useEffect, useId, useRef, useState} from 'react';
import {Popover} from 'react-aria-components';
import {useMedia} from '../app/hooks';
import {useCatalog} from '../app/store';
import {useFilmNavigation} from '../app/film-navigation';
import {Badges} from './ScreeningCard';
import {doubanMappingOf, doubanUrlOf, filmInfoOf, filmNodeKey, fmtDuration, fmtEndClock} from '../util';
import {effEndMin, talkOnOf} from '../gv';
import {introOf} from '../intros';
import {mapsUrl, regionLabel, venuePlace} from '../legend';
import {indexFestival, relatedOf} from '../related';
import {store} from '../state';
import type {Screening} from '../types';

export function ScreeningInfoPopover({screening: s}: {screening: Screening}) {
  const {cat} = useCatalog();
  const openFilm = useFilmNavigation();
  const compact = useMedia("(max-width: 768px)");
  // 显示口径(2026-09-17,`PLAN-20260917003630`):鼠标**悬停即展开、指针移开即收**。
  //   `pinned`(点开点关)只留给没有 hover 可依赖的键盘 / 触摸 —— 原先鼠标点一下也会钉住,
  //   而弹层就压在网格上,点错一下就得再点「×」才收(用户原话「点击了之后 还要点击关闭」)。
  const [mode, setMode] = useState<'closed' | 'hover' | 'pinned'>('closed');
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最近一次 pointerdown 的指针类型:用来把「鼠标点击」与「键盘 / 触摸激活」分开
  // (键盘激活按钮不产生 pointerdown,故这里为空串 → 走 pinned 分支)
  const pointerKind = useRef('');
  const id = useId();
  const cancel = () => { if (timer.current) clearTimeout(timer.current); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (mode === 'pinned') content.current?.focus({preventScroll:true});
  }, [mode]);
  const close = () => {
    cancel();
    if (mode === 'pinned') trigger.current?.focus({preventScroll:true});
    setMode('closed');
  };
  const leave = () => {
    cancel();
    if (mode !== 'pinned') timer.current = setTimeout(() => setMode(current => current === 'pinned' ? current : 'closed'), 220);
  };
  const venue = cat.venueById.get(s.venue_id);
  const place = venuePlace(venue?.group);
  const info = filmInfoOf(cat,s,store.mappings.get(s.code));
  // 与场次卡 / 影片库卡 / 影片资料弹层同一口径:有场次按 code,未命中退目录片 id
  // (2026-09-17,`PLAN-20260917010426`)。这里只管「取哪条映射」,href 仍走 `doubanUrlOf`。
  const mapping = doubanMappingOf(store.mappings, {code: s.code, filmId: info.cats[0]?.id});
  const intro = introOf(mapping?.subject_id);
  const related = relatedOf(mapping?.subject_id, store.mappings);
  const festival = indexFestival(store.mappings);
  const doubanUrl = doubanUrlOf(info, mapping);
  return <>
    <button ref={trigger} className="gantt-info" type="button"
      aria-label={`场次 ${s.code} 影片资料`} aria-haspopup="dialog" aria-expanded={mode !== 'closed'} aria-controls={mode !== 'closed' ? id : undefined}
      onPointerEnter={event => { if(event.pointerType === 'mouse') { cancel(); if(mode === 'closed') timer.current = setTimeout(()=>setMode('hover'),180); } }}
      onPointerLeave={leave}
      onPointerDown={event => { pointerKind.current = event.pointerType; }}
      onClick={() => {
        cancel();
        const mouse = pointerKind.current === 'mouse';
        pointerKind.current = '';
        // 鼠标:只负责「立刻展开」(不等 180ms 延时),收不收交给指针移开 —— 一律不进入 pinned
        if (mouse) { setMode('hover'); return; }
        // 键盘 / 触摸:没有 hover 可依赖,点开 → 再点一次 ⓘ / `×` / Escape 才收
        if (mode === 'closed') setMode('pinned');
        else close();
      }}
    ><svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10" cy="10" r="7.5" /><path d="M10 9v6" /><circle cx="10" cy="6" r="1" fill="currentColor" stroke="none" /></svg></button>
    <Popover triggerRef={trigger} isOpen={mode !== 'closed'} onOpenChange={open => {if(!open) close();}}
      shouldCloseOnInteractOutside={element => !trigger.current?.contains(element)}
      isNonModal placement={compact ? "bottom" : "right top"} offset={8} className="screening-info-popover"
      onPointerEnter={cancel} onPointerLeave={leave}>
      {/* 不再用 `onFocus` 钉住:React 的 focus 是冒泡的,鼠标点弹层里任何一处都会把它锁死 */}
      <div ref={content} id={id} role="dialog" tabIndex={-1} aria-label={`场次 ${s.code} 影片预览`}>
        <button className="preview-close" type="button" aria-label="关闭影片预览" onClick={close}>×</button>
        <div className="preview-hero">
          {info.cats[0]?.poster && <img className="preview-poster" src={info.cats[0].poster} alt={`${info.zh || info.en} 海报`} />}
          <div className="preview-heading">
            <strong>{info.en || info.zh}</strong>
            {info.zh && info.zh !== info.en && <p className="preview-translation">{info.zh}</p>}
          </div>
        </div>
        <p className="muted">{s.date} {s.start_time.slice(0,5)}-{fmtEndClock(effEndMin(s,talkOnOf(s.code)))} KST</p>
        <p>{venue?.name}　{fmtDuration(s.duration_min)}</p>
        {place && <p className="muted preview-venue">{regionLabel(place.region)} · {place.location}<br />{place.address}<br /><a href={mapsUrl(place)} target="_blank" rel="noopener noreferrer">在 Google 地图打开</a></p>}
        <Badges screening={s} />
        <ScreeningMemberList screening={s} onOpen={() => {cancel();setMode('closed');}} />
        {info.meta && <p className="muted">{info.meta}</p>}
        {intro && <p className="preview-intro">{intro}</p>}
        {related.festival.length > 0 && <section className="preview-related" aria-label="本届相关影片">
          <h4>本届相关影片</h4>
          <div className="preview-related-links">
            {related.festival.map(rec => {
              const ref = festival.get(rec.id);
              const show = ref?.code ? cat.byCode.get(ref.code) : undefined;
              const key = show ? filmNodeKey(cat, show) : ref?.filmId ? `cat:${ref.filmId}` : null;
              return key ? <button key={rec.id} type="button" onClick={() => {cancel();setMode('closed');openFilm(key, show?.code);}}>{rec.title}{rec.year ? `（${rec.year}）` : ""}{rec.rating != null ? `，豆瓣 ${rec.rating}` : ""}</button> : null;
            })}
          </div>
        </section>}
        {related.more.length > 0 && <section className="preview-related" aria-label="更多相关电影">
          <h4>更多相关电影</h4>
          <ul>{related.more.map(rec => <li key={rec.id}><a href={rec.url} target="_blank" rel="noopener noreferrer">{rec.title}{rec.year ? `（${rec.year}）` : ""}{rec.rating != null ? `，豆瓣 ${rec.rating}` : ""}</a></li>)}</ul>
        </section>}
        <div className="preview-actions">
        <button type="button" className="preview-full" onClick={() => {cancel();setMode('closed');openFilm(filmNodeKey(cat,s),s.code);}}>查看完整影片资料</button>
        <a className="preview-full preview-douban" href={doubanUrl} target="_blank" rel="noopener noreferrer" title={mapping?.douban_url ? undefined : "未匹配豆瓣条目，将搜索影片名称"}>在豆瓣打开</a>
        </div>
      </div>
    </Popover>
  </>;
}
