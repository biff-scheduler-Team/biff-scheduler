import {ScreeningMemberList} from "../components/ScreeningMemberList";
import { useCallback, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  DialogContainer,
  Heading,
  Link,
} from "../components/spectrum";
import { useCatalog } from "../app/store";
import { FILM_CODE_PARAM, useFilmNavigation } from "../app/film-navigation";
import { filmDetailAnchor, filmDetailNames } from "../app/film-details";
import { introOf } from "../intros";
import { indexFestival, relatedOf } from "../related";
import { KIND_LABEL, programOf, formatKrw } from "../extras";
import { store } from "../state";
import { doubanScoreOf, filmNodeKey, fmtVoters } from "../util";

export function FilmDialog() {
  const { filmKey = "" } = useParams();
  const { cat, filmByKey } = useCatalog();
  const location = useLocation();
  const navigate = useNavigate();
  const openFilm = useFilmNavigation();
  const readingPositions = useRef(new Map<string, { content: number; dialog: number }>());
  const rememberReadingPosition = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    // Spectrum scrolls Content normally and the whole Dialog in short viewports.
    const content = node.parentElement!;
    const dialog = node.closest<HTMLElement>('[role="dialog"]');
    const saved = readingPositions.current.get(location.key);
    const restore = () => {
      content.scrollTop = saved?.content ?? 0;
      if (dialog) dialog.scrollTop = saved?.dialog ?? 0;
    };
    restore();
    // Dialog autofocus runs during mounting; restore after it has placed focus.
    const frame = requestAnimationFrame(restore);
    return () => {
      cancelAnimationFrame(frame);
      readingPositions.current.set(location.key, {
        content: content.scrollTop,
        dialog: dialog?.scrollTop ?? 0,
      });
    };
  }, [location.key]);
  const close = () => {
    if (location.state?.filmDialog) navigate(-1);
    else {
      const params = new URLSearchParams(location.search);
      params.delete(FILM_CODE_PARAM);
      const search = params.size ? `?${params}` : "";
      navigate(`${location.pathname.split("/films/")[0]}${search}`, {
        replace: true,
      });
    }
  };
  const film = filmByKey.get(filmKey);
  const anchor = filmDetailAnchor(film, new URLSearchParams(location.search).get(FILM_CODE_PARAM));
  const mapping = anchor
    ? store.mappings.get(anchor.code)
    : film?.map ?? store.mappings.get(film?.cats[0]?.id ?? "");
  const intro = introOf(mapping?.subject_id);
  const score = doubanScoreOf(film?.cats[0], mapping);
  const related = relatedOf(mapping?.subject_id, store.mappings);
  const fest = indexFestival(store.mappings);
  const program = anchor ? programOf(anchor.code) : undefined;
  return (
    <DialogContainer onDismiss={close}>
      <Dialog key={location.key} size="L">
        <Heading slot="title">{film?.zh ?? "找不到这部影片"}</Heading>
        <Content>
            {film ? (
              <div className="film-detail" ref={rememberReadingPosition}>
                <div className="detail-heading">
                  {film.poster && (
                    <img src={film.poster} alt={`${film.zh} 海报`} />
                  )}
                  <div>
                    <h2>{film.en}</h2>
                    <p>{filmDetailNames(film, anchor?.title_kr).join(" / ")}</p>
                    <p className="muted">{film.meta.replaceAll(" · ", "，")}</p>
                    {!film.shows.length && film.cats[0]?.remark && (
                      <p className="muted">备注：{film.cats[0].remark}</p>
                    )}
                    {score && (
                      <p className="score">
                        豆瓣 {score.rating.toFixed(1)}
                        {score.count
                          ? `，${fmtVoters(score.count)} 人评分`
                          : ""}
                      </p>
                    )}
                    <div className="inline-actions">
                      {mapping?.douban_url ? <Link
                        href={mapping.douban_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        在豆瓣查看
                      </Link> : <>
                        <Link
                          href={`https://www.douban.com/search?q=${encodeURIComponent(film.zh.trim() || film.en.trim())}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >中文搜索</Link>
                        <Link
                          href={`https://www.douban.com/search?q=${encodeURIComponent(film.en)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >英文搜索</Link>
                      </>}
                    </div>
                  </div>
                </div>
                {intro && (
                  <section>
                    <h2>影片简介</h2>
                    <p className="intro">{intro}</p>
                  </section>
                )}
                {film.block && (
                  <p className="notice">
                    收录于合集 {film.block.title_en}，与合集内其他影片一同放映。
                  </p>
                )}
                {film.shows.find(s => s.midnight_members?.length) && <ScreeningMemberList screening={film.shows.find(s => s.midnight_members?.length)!} />}
                {program && (
                  <section>
                    <h2>{KIND_LABEL[program.kind].replaceAll(" · ", "，")}</h2>
                    <p>
                      {program.guestZh} {program.guest}
                    </p>
                    <p>{program.language}</p>
                    <p>{program.moderator}</p>
                    <p>{program.bio}</p>
                    {program.priceKrw && <p>{formatKrw(program.priceKrw)}</p>}
                    {program.dateText && <p className="muted">官网原文：{program.dateText}</p>}
                  </section>
                )}
                {!film.shows.length && !film.block && <p className="muted">暂无已发布排期。</p>}
                {related.festival.length > 0 && (
                  <section>
                    <h2>本届相关影片</h2>
                    <div className="related-list">
                      {related.festival.map((rec) => {
                        const ref = fest.get(rec.id);
                        const s = ref?.code
                          ? cat.byCode.get(ref.code)
                          : undefined;
                        const key = s
                          ? filmNodeKey(cat, s)
                          : ref?.filmId
                            ? `cat:${ref.filmId}`
                            : null;
                        return key ? (
                          <ActionButton
                            key={rec.id}
                            onPress={() => openFilm(key, s?.code)}
                          >
                            {rec.title}
                            {rec.year ? `，${rec.year}` : ""}
                            {rec.rating != null ? `，豆瓣 ${rec.rating}` : ""}
                          </ActionButton>
                        ) : null;
                      })}
                    </div>
                  </section>
                )}
                {related.more.length > 0 && (
                  <section>
                    <h2>更多相关电影</h2>
                    <ul>
                      {related.more.map((rec) => (
                        <li key={rec.id}>
                          <Link
                            href={rec.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {rec.title}
                            {rec.year ? `，${rec.year}` : ""}
                            {rec.rating != null ? `，豆瓣 ${rec.rating}` : ""}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            ) : (
              <p>这部影片不在当前目录中，可以返回影片库重新查找。</p>
            )}
        </Content>
        <ButtonGroup>
          <Button variant="secondary" onPress={close}>
            返回
          </Button>
        </ButtonGroup>
      </Dialog>
    </DialogContainer>
  );
}
