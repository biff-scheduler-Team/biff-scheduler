import { useLocation, useNavigate } from "react-router";
import { navSearch } from "./nav-query";
import { useCatalog } from "./store";

/** 影片库 / 我的选片 / 我的行程 / 影片弹层共用这一份跳转契约。
 * 请求令牌能穿过普通的面板切换，但用户再次「定位」时必然换一个 ——
 * 否则切个标签就会把上一次的定位请求重放一遍。
 */
export function useScheduleNavigation() {
  const { cat } = useCatalog();
  const location = useLocation();
  const navigate = useNavigate();
  const go = (date: string, code?: string) => {
    if (!cat.dates.includes(date)) return;
    // 跨页定位(影片库 / 我的行程 → 排片表):只带排片表自己的参数,别把来源页的搜索词搬过去
    const params = new URLSearchParams(
      navSearch(location.search, location.pathname, "/schedule"),
    );
    params.set("date", date);
    params.set("locate", crypto.randomUUID());
    params.delete("hour");
    params.delete("quick");
    if (code) {
      params.set("focus", code);
      params.delete("focusDate");
    } else {
      params.delete("focus");
      params.set("focusDate", date);
    }
    navigate(`/schedule?${params}`);
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
