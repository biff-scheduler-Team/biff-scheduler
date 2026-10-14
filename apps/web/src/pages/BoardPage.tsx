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
 */

import { useEffect } from "react";
import { Outlet, useSearchParams } from "react-router";
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
  useEffect(() => {
    if (sort) return;
    const draft = new URLSearchParams(params);
    draft.set("sort", params.has("q") ? "red" : "hot");
    setParams(draft, { replace: true });
  }, [sort, params, setParams]);

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

      {tab === "hot" ? <HotBoardPanel /> : <RedBlackPage hideSortBar />}

      {/* ⚠ **必须渲染 `Outlet`**：路由表里本页挂了 `filmRoute()` 子路由（`films/:filmKey` →
          `FilmDialog`），热门影片榜的海报点击就是走它打开详情。不渲染 Outlet 的话那条路由
          永远不会命中 —— 点海报会「什么都没发生」（`RushAnalysisPage` 里记过同一个坑）。
          ⚠ 位置在榜单之后、不影响任何既有布局：弹层挂在 `DialogContainer` 上，不占版面。 */}
      <Outlet />
    </div>
  );
}
