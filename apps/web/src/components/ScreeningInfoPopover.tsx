import {ScreeningMemberList} from './ScreeningMemberList';
import {useEffect, useId, useRef, useState} from 'react';
import {Popover} from 'react-aria-components';
import {useMedia} from '../app/hooks';
import {useCatalog} from '../app/store';
import {useFilmNavigation} from '../app/film-navigation';
import {Badges} from './ScreeningCard';
import {doubanUrlOf, filmInfoOf, filmNodeKey, fmtEndClock} from '../util';
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
  const [mode, setMode] = useState<'closed' | 'hover' | 'pinned'>('closed');
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const mapping = store.mappings.get(s.code);
  const intro = introOf(mapping?.subject_id);
  const related = relatedOf(mapping?.subject_id, store.mappings);
  const festival = indexFestival(store.mappings);
  const doubanUrl = doubanUrlOf(info, mapping);
  return <>
    <button ref={trigger} className="gantt-info" type="button"
      aria-label={`场次 ${s.code} 影片资料`} aria-haspopup="dialog" aria-expanded={mode !== 'closed'} aria-controls={mode !== 'closed' ? id : undefined}
      onPointerEnter={event => { if(event.pointerType === 'mouse') { cancel(); if(mode === 'closed') timer.current = setTimeout(()=>setMode('hover'),180); } }}
      onPointerLeave={leave}
      onClick={() => { cancel(); requestAnimationFrame(() => setMode('pinned')); }}
    ><svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10" cy="10" r="7.5" /><path d="M10 9v6" /><circle cx="10" cy="6" r="1" fill="currentColor" stroke="none" /></svg></button>
    <Popover triggerRef={trigger} isOpen={mode !== 'closed'} onOpenChange={open => {if(!open) close();}}
      shouldCloseOnInteractOutside={element => !trigger.current?.contains(element)}
      isNonModal placement={compact ? "bottom" : "right top"} offset={8} className="screening-info-popover"
      onPointerEnter={cancel} onPointerLeave={leave}>
      <div ref={content} id={id} role="dialog" tabIndex={-1} aria-label={`场次 ${s.code} 影片预览`}
        onFocus={() => {cancel();setMode('pinned');}}>
        <button className="preview-close" type="button" aria-label="关闭影片预览" onClick={close}>×</button>
        <div className="preview-hero">
          {info.cats[0]?.poster && <img className="preview-poster" src={info.cats[0].poster} alt={`${info.zh || info.en} 海报`} />}
          <div className="preview-heading">
            <strong>{info.en || info.zh}</strong>
            {info.zh && info.zh !== info.en && <p className="preview-translation">{info.zh}</p>}
          </div>
        </div>
        <p className="muted">{s.date} {s.start_time.slice(0,5)}-{fmtEndClock(effEndMin(s,talkOnOf(s.code)))} KST</p>
        <p>{venue?.name}　{s.duration_min} 分钟</p>
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
