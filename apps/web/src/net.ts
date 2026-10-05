// 请求超时的**唯一**表达（2026-10-05，PLAN-20261005182415 §A）。
//
// 由来：全站十来处 `fetch` 都写着 `signal: AbortSignal.timeout(12_000)`，而 `AbortSignal.timeout`
// 是 Safari **16.4**（2023 年）才有的 API —— 旧 Safari 与部分内嵌 WebView 上它是 `undefined`，
// 那一句会在 `fetch` **之前**同步抛 `TypeError`，再被各模块的 `catch` 当成「网络不通」：
//   · 红黑榜那边表现是「贴纸永远同步不上去，提示一直说检查网络」（用户 2026-10-05 报的症状）；
//   · 读接口会同样静默退化成空表 —— 于是「读挂了」与「真的没人贴过」在界面上长得一模一样。
//
// 仓库此前把它登记成一条**未决风险**：「`AbortSignal.timeout` 无兜底（旧 Safari / 内嵌浏览器）｜
// 需先确认目标浏览器矩阵；无矩阵时加兜底属于凭猜测改代码」（见 `PLAN-20260923111748.md` 的
// 已知问题表）。2026-10-05 用户决定支持旧机型，于是这里把兜底做掉 —— 而且**只做这一处**：
// 各模块继续只回答「超时多久」，不再各写一份兼容代码（AGENTS §5 口径单一来源）。
//
// ⚠ 为什么不能图省事写 `AbortSignal.timeout?.(ms)`：旧环境里那会传 `undefined` 给 `signal`，
//   fetch 把它当成「没有信号」—— 请求就**永远挂着**（弹层关不掉、页面停在加载态），
//   比直接抛错更难查。所以兜底必须给出一个**真能中止**的信号。

/** 给 `fetch` 用的**硬超时**信号：能用原生 `AbortSignal.timeout` 就用，否则退到
 *  `AbortController` + `setTimeout`。两条路的语义一致：到点 abort，调用方的 `catch` 拿到
 *  一个 AbortError（与「网络不通」走同一个分支，各模块的降级行为不用改）。 */
export function timeoutSignal(ms: number): AbortSignal {
  // ⚠ 能力检测必须写成 `typeof … === "function"`：旧 Safari 上 `AbortSignal.timeout` 是
  //    `undefined`，直接调用就是 `TypeError`（那正是本条要修的东西）。
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  // ⚠ 刻意**不 clearTimeout**：信号是给一次请求用的，计时器空转一次（`abort()` 幂等）而已；
  //    为它记一个「请求已结束」的开关，等于多一处状态要维护、多一处会忘。
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
