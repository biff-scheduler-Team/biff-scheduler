import { useLocation, useNavigate } from "react-router";
import { useMedia } from "./hooks";
import { useCatalog } from "./store";

/** One navigation contract for library, picks, agenda, and film dialogs.
 * The request token survives ordinary panel navigation, but changes when the
 * user locates again. Switching tabs must not replay an old locate request.
 */
export function useScheduleNavigation() {
  const { cat } = useCatalog();
  const location = useLocation();
  const navigate = useNavigate();
  const singlePane = useMedia("(max-width: 1099px)");
  const go = (date: string, code?: string) => {
    if (!cat.dates.includes(date)) return;
    const params = new URLSearchParams(location.search);
    params.set("date", date);
    params.set("locate", crypto.randomUUID());
    params.delete("hour");
    if (code) {
      params.set("focus", code);
      params.delete("focusDate");
    } else {
      params.delete("focus");
      params.set("focusDate", date);
    }
    const panel = location.pathname.match(/^\/(library|picks|agenda)(?:\/|$)/)?.[1];
    const path = !singlePane && panel ? `/${panel}` : "/schedule";
    navigate(`${path}?${params}`);
  };
  return {
    locateScreening(code: string) {
      const s = cat.byCode.get(code);
      if (s) go(s.date, code);
    },
    locateDate(date: string) {
      go(date);
    },
  };
}
