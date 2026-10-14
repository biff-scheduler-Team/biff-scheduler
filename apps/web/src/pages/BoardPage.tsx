/**
 * 「榜单」页的外壳（2026-10-14，`PLAN-20261014150805` 修订 1 / 2）。
 *
 * ★ 为什么要有这一层：原先「红黑榜」是一整页，现在多出一个**热门榜**（按想看人数排，
 *   见 `hot-board.ts`），两者并列成页内 tab —— 用户 2026-10-14：「叫热门榜单吧…
 *   红黑榜也需要在分享的时候根据单元切分」「页内 tab 切换」。
 *
 * ★ **档位仍走 URL**（`?sort=`）：`RedBlackPage` 本来就从 `?sort=red|black` 读档位
 *   （它文件里那句「老的 `?sort=total` 与任何非法值都落回红榜」）。这里**沿用同一个参数**
 *   承载三个 tab，于是：
 *   · 老书签 `/redblack?sort=black` 照常落在黑榜；
 *   · `/redblack?sort=total`（总数榜已撤）与非法值照常落回红榜；
 *   · 不新增第二个参数，两个 tab 与页内档位不会互相打架。
 *
 * ★ **缺省 tab 的判定**（唯一的「魔法」，理由写在这里）：
 *   · 有 `?q=` → **红榜**。它是从日程表格子「去评分」跳进来的
 *     （`e2e/react/agenda-gantt.spec.ts` 断言 `/redblack?q=`），那人是要**贴贴纸**的，
 *     给热门榜等于把他挡在门外；
 *   · 否则 → **热门榜**。从导航进来的第一眼，就该看到这一轮的新门面。
 *
 * ⚠ 本页**不引 ECharts**（见 `hot-board.ts` 文件头与 PLAN 修订 1 的硬约束）。
 *
 * ★ **修订 2（2026-10-14，`PLAN-20261014190000`）：页头多了一枚「快速投票」。**
 *   用户原话：「快速投票放到和热门榜 红榜 黑榜的头部处」。要点三条：
 *   · 它是**动作**不是 tab —— 在 `role=tablist` **之外**，不参与 `aria-selected`；
 *   · 「开没开」走 URL（`?vote=1`），与 `sort` 同一层 —— 因为要打开的那张卡片是
 *     `RedBlackPage` 渲染的，而本页在「热门榜」下不挂它，用 state 会错一拍；
 *   · 从热门榜点进去会**顺带把 `sort` 落成红榜**（红黑榜缺省档），否则切过去的是空气。
 *     于是关掉卡片之后落在红黑榜上，而不是把你甩回热门榜。
 *
 * ★ **修订 3（同日）：落地就弹。** 用户：「都改成默认弹出这个快速投票 … 如果行程没有主动点击
 *   就改成 TOP50 给用户进行滑动吧」。具体是：
 *   · **我的行程里有片** → 落地直接 `?sort=red&vote=1`，卡片当场弹出来（不用先点按钮）；
 *   · **行程为空** → 不弹（空卡片只会让人以为坏了），照旧落热门榜；
 *     用户**主动点**页头那枚按钮时，才拿热门榜 **TOP50** 当候选。
 *   ⚠ 「缺省档」与「自动弹」都只在 `sort` 缺失时决定一次 —— 否则关掉卡片、切个 tab 又会被弹回来。
 */

import { useEffect, useRef } from "react";
import { Outlet, useSearchParams } from "react-router";
import { store } from "../state";
import { HotBoardPanel } from "../components/HotBoardPanel";
import { RedBlackPage } from "./RedBlackPage";
import "./hot-board.css";

type BoardTab = "hot" | "red" | "black";

/** tab 的**唯一**来源（标签只写这一份）。 */
const TABS: ReadonlyArray<{ id: BoardTab; label: string }> = [
  { id: "hot", label: "热门榜" },
  { id: "red", label: "红榜" },
  { id: "black", label: "黑榜" },
];

function readTab(params: URLSearchParams): BoardTab {
  const raw = params.get("sort");
  if (raw === "hot" || raw === "black" || raw === "red") return raw;
  return params.has("q") ? "red" : "hot";
}

export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const sort = params.get("sort");
  const tab = readTab(params);

  /* 快速投票卡片开着没有（`?vote=1`）。
   * ⚠ 焦点归还由**本页**负责：那枚入口按钮在页头上，而弹层是子页（`RedBlackPage`）渲染的 ——
   *   只有按钮的主人知道「关掉之后该把焦点还给谁」。子页那边因此**故意不写**这一段，
   *   否则同一件事会有两处实现，而它们迟早会给出不同的落点。 */
  const voting = params.get("vote") === "1";
  const quickBtnRef = useRef<HTMLButtonElement | null>(null);
  const wasVotingRef = useRef(false);
  useEffect(() => {
    // ⚠ 只在「开过再关」时才还 —— 直接判 `!voting` 的话,首帧就会把焦点抢到这颗按钮上。
    if (wasVotingRef.current && !voting) quickBtnRef.current?.focus();
    wasVotingRef.current = voting;
  }, [voting]);

  // ★ 把「隐含推出来的档位」一次性写成**显式参数**（`replace`，不留历史记录）。
  //
  //   为什么非做这一步不可：缺省档是靠 `?q=` 的**有无**推出来的，而 `q` 会在页面内被清掉
  //   （清空搜索框、讨论区总览定位时自动清过滤、点「去评分」之后再手改搜索词…）。
  //   不固化的话，`q` 消失那一刻 `sort` 还是空的 —— 档位会**当场从红榜翻到热门榜**，
  //   把正在看榜单的人甩到另一个视图（2026-10-14 本地跑 E2E 时实测抓到：
  //   「讨论区总览：目标被搜索框挡住时,自动清掉过滤再定位」那条就是这么红的）。
  //
  //   ⚠ 依赖里只认 `sort`：第二次渲染它就有值了，effect 不会再转第二圈（不会死循环）。
  //   ⚠ 用 `replace` 而不是 push：这是**规范化**，不该在浏览器历史里多出一条记录
  //     （否则「后退」会退到一个同样内容的 URL 上，看起来像没反应）。
  /** 落地时缺省落哪一档、要不要**自动弹出快速投票**（2026-10-14 修订 3，用户:
   *  「都改成默认弹出这个快速投票 … 如果行程没有主动点击就改成 TOP50 给用户进行滑动吧」）。
   *
   *  ⚠ 判据是**我的行程里有没有片**（`store.picks`），**不是**「有没有投过票」——
   *    快速投票**就是**已投过的片子的改票入口，拿「都投完了」把它挡掉是反的。
   *  ⚠ 行程为空 → **不自动弹**（弹一张空卡片只会让人以为坏了），照旧落在热门榜；
   *    这时用户**主动点**页头那枚「快速投票」才走兜底候选（热门榜 TOP50，见 `RedBlackPage::deck`）。
   *  ⚠ 只在**这一档缺失时**跑（`if (sort) return`）：它回答的是「落地缺省」，不是「每次进页都弹」——
   *    否则用户从卡片里关掉、随手切一下 tab，又会被弹回来（那是很烦的那类弹窗）。
   *  ⚠ 这里**不订阅 `useStore()`**：它是个**落地时刻**的判断，不是要跟着变的界面状态 ——
   *    订阅了只会让这个 effect 在每次改行程时白跑一遍（而那时 `sort` 早就有了，第一行就返回）。 */
  const hasAgenda = store.picks.size > 0;
  useEffect(() => {
    if (sort) return;
    const draft = new URLSearchParams(params);
    // ⚠ 要弹卡片就必须落**红榜**：卡片是 `RedBlackPage` 渲染的，而热门榜那一支根本不挂它 ——
    //   落成热门榜会得到一个「开着投票但卡片不见了」的死状态（`?vote=1` 是被分享出去过的形态）。
    draft.set("sort", params.has("q") || hasAgenda || draft.get("vote") === "1" ? "red" : "hot");
    if (hasAgenda) draft.set("vote", "1");
    setParams(draft, { replace: true });
  }, [sort, params, setParams, hasAgenda]);

  /** 切 tab：只动 `sort`，**其余参数原样保留**（搜索词 `q` 是同一页的语义，不该被切 tab 清掉）。
   *  ⚠ 三档都**显式**写进 URL —— 缺省档不再靠「删掉参数」表达，那正是上面那个翻转 bug 的成因。 */
  const pick = (next: BoardTab) => {
    const draft = new URLSearchParams(params);
    draft.set("sort", next);
    setParams(draft);
  };

  return (
    <div className="board-page">
      {/* 分段控件形态与 `RedBlackPage` 的 `.rb-seg` 一致（同一个应用里「互斥选项」长得一样）。
          ⚠ 语义是 `role=tablist` + `aria-selected`，不是 `aria-pressed` —— 这一层切的是
            **整块视图**（热门榜 ↔ 红黑榜），与页内那个「红榜 / 黑榜」分段控件不是一回事：
            后者的档位由本页的 tab 决定，所以红黑榜那一边**不再渲染**它自己的分段控件。 */}
      <div className="board-head">
        <nav className="board-tabs" role="tablist" aria-label="榜单视图">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="board-tab"
              data-board-tab={id}
              aria-selected={tab === id}
              onClick={() => pick(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        {/* 「快速投票」—— 用户 2026-10-14：「放到和热门榜 / 红榜 / 黑榜的头部处」。
         *
         *  ⚠ 它与那三个并排，但**不是 tab**（在 `tablist` 之外、没有 `role=tab`）：
         *    它不切换「在看哪一份榜」，而是**打开一张投票卡片**。塞进 tablist 会让读屏把它
         *    念成第四个视图，而 `aria-selected` 在这里根本说不通。
         *
         *  ⚠ 2026-10-14 修订 3：**行程里有片时这一页落地就自动弹卡片**（见上面那个 effect），
         *    所以这枚按钮真正的用武之地是**行程为空**那一档 —— 那时它打开的是热门榜 TOP50 兜底
         *    （用户：「如果行程没有主动点击就改成 TOP50 给用户进行滑动吧」）。
         *
         *  ⚠ 它打开的卡片（`QuickVoteDeck`）是 `RedBlackPage` 渲染的 —— 而本页在「热门榜」
         *    下压根不挂 `RedBlackPage`。所以这里不能只写 `?vote=1`：从热门榜点进去必须
         *    同时把 `sort` 落到**红黑榜**（缺省红榜），否则切过去的是空气。
         *    从红榜 / 黑榜点则原样保留当前档位 —— 关掉卡片就落回你原来在看的那一份榜。
         *
         *  ⚠ 「开没开」由 URL 承载（`?vote=1`），与 `RedBlackPage` 同读同一个参数：
         *    用 state 的话「切 tab → 本页重渲染 → 子页刚挂载」这条路上，开关与视图会**错一拍**。 */}
        <button
          ref={quickBtnRef}
          type="button"
          className="board-quick"
          onClick={() => {
            const draft = new URLSearchParams(params);
            if (tab === "hot") draft.set("sort", "red");
            draft.set("vote", "1");
            setParams(draft);
          }}
        >
          快速投票
        </button>
      </div>

      {tab === "hot" ? <HotBoardPanel /> : <RedBlackPage hideSortBar />}

      {/* ⚠ **必须渲染 `Outlet`**：路由表里本页挂了 `filmRoute()` 子路由（`films/:filmKey` →
          `FilmDialog`），热门影片榜的海报点击就是走它打开详情。不渲染 Outlet 的话那条路由
          永远不会命中 —— 点海报会「什么都没发生」（`RushAnalysisPage` 里记过同一个坑）。
          ⚠ 位置在榜单之后、不影响任何既有布局：弹层挂在 `DialogContainer` 上，不占版面。 */}
      <Outlet />
    </div>
  );
}
