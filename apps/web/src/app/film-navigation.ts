import { useLocation, useNavigate } from "react-router";

export const FILM_CODE_PARAM = "filmCode";

/** 把场次身份留在 URL 里：刷新后的详情链接仍然指向那一场。 */
export function useFilmNavigation(): (filmKey: string, code?: string) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return (filmKey, code) => {
    const base = location.pathname.split("/films/")[0] || "/library";
    const params = new URLSearchParams(location.search);
    if (code) params.set(FILM_CODE_PARAM, code);
    else params.delete(FILM_CODE_PARAM);
    const search = params.size ? `?${params}` : "";
    navigate(`${base}/films/${encodeURIComponent(filmKey)}${search}`, {
      state: { filmDialog: true },
    });
  };
}
