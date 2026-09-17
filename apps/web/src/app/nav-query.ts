/** 导航查询串的**唯一口径**(2026-09-17,`PLAN-20260917002528`)。
 *
 *  ★ 起因:各页面把自己的搜索词 / 筛选写进 URL 的**同名 key** —— `q` 在「影片库」「红黑榜」
 *    「吃喝」三页各有一份语义(片名 / 榜单片名 / 店名),`focus` 在「排片表」与「讨论区」
 *    各有一份(场次 code / 帖子 code)—— 而主导航原先**把整条 search 原样**拼到每个链接上
 *    (`App.tsx` 里的 `to={`${path}${pageSearch}`}`)。于是「影片库里搜 Midnight Passion」
 *    切到「吃喝」时,吃喝的搜索框里也躺着 Midnight Passion,列表被同一根 needle 过滤成空。
 *
 *  ★ 口径:同名 key **不跨页** —— 只有下面登记的「跨页保留」参数能跟着走,
 *    其余(含未知参数)在切到**另一个页面**时一律丢掉;同页导航(如浮动面板「打开完整页面」)
 *    则原样保留。想再加跨页参数,必须先登记进 `GLOBAL_PARAMS`,否则会被静默丢掉。
 */

/** 跨页保留的参数:排片表的浏览上下文。
 *  `date` / `hour` 由 `schedule-selection.tsx`(应用级 Provider)读取 —— 切页再切回来必须保持,
 *  否则「在影片库挑完片子回排片表」会掉回默认日期。 */
export const GLOBAL_PARAMS: readonly string[] = ["date", "hour"];

/** 路由的**宿主页面**:影片资料弹层挂在宿主页之下(`/library/films/f1` 的宿主是 `/library`),
 *  归属按宿主算 —— 在弹层里做同页动作不该被当成「跨页」。 */
function hostPath(path: string): string {
  const base = path.split("?")[0].split("/films/")[0];
  return base || "/";
}

/** 生成「从 `from` 导航到 `to`」时要带上的查询串(含 `?`;无参数时返回空串)。
 *
 *  `quick`(浮动面板开关)一律剔除,由调用方自己决定是否加回 —— 各调用点对面板的态度并不一致。 */
export function navSearch(search: string, from: string, to: string): string {
  const crossPage = hostPath(from) !== hostPath(to);
  const params = new URLSearchParams(search);
  for (const key of [...params.keys()]) {
    const keep =
      key !== "quick" && (!crossPage || GLOBAL_PARAMS.includes(key));
    if (!keep) params.delete(key);
  }
  return params.size ? `?${params}` : "";
}
