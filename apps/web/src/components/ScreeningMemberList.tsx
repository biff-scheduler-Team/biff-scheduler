import {useCatalog} from '../app/store';
import {useFilmNavigation} from '../app/film-navigation';
import {screeningMembers} from '../app/screening-members';
import {fmtDuration} from '../util';
import type {Screening} from '../types';

export function ScreeningMemberList({screening, onOpen}: {screening: Screening; onOpen?: () => void}) {
  const {cat} = useCatalog();
  const openFilm = useFilmNavigation();
  const members = screeningMembers(cat, screening);
  if (!members.length) return null;
  return <section className="screening-members" aria-label="联映影片">
    <h4>{members.length} 部联映，共用一个场次</h4>
    {members.map(({name, film}) => <div className="screening-member" key={name}>
      {film?.poster && <img src={film.poster} alt={`${film.title_zh || name} 海报`} />}
      <div>
        <strong>{name}</strong>
        {film?.title_zh && film.title_zh !== name && <span>{film.title_zh}</span>}
        {film && <span className="muted">{[film.year, film.duration_min ? fmtDuration(film.duration_min) : '', film.director].filter(Boolean).join('，')}</span>}
        {film && <button type="button" className="preview-full" aria-label={`查看 ${film.title_zh || name} 影片资料`} onClick={() => {onOpen?.();openFilm(`cat:${film.id}`);}}>影片资料</button>}
      </div>
    </div>)}
  </section>;
}
