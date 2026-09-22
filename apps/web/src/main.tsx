import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, Outlet } from "react-router";
import { bootstrap } from "./app/store";
import { IndexRedirect, Loading, Root, RouteError } from "./app/App";
import { LibraryPage } from "./pages/LibraryPage";
import { FeedbackPage } from "./pages/FeedbackPage";
import { AgendaPage } from "./pages/AgendaPage";
import { RedBlackPage } from "./pages/RedBlackPage";
import { RushPage } from "./pages/RushPage";
import { EatsPage } from "./pages/EatsPage";
import { FilmDialog } from "./pages/FilmDialog";
import { installUpdateWatch } from "./pwa-update";
import "./style.css";

// 挂在**顶层**,不是组件 effect:注入的 `registerSW.js` 在 `window.load` 就注册 SW,
// 而模块脚本执行早于 `window.load` —— 只有这里够早,才能保证「新版接管」的那次
// `controllerchange` 不被漏掉(2026-09-22,PLAN-20260922100704;理由见 pwa-update.ts)。
installUpdateWatch();

const filmRoute = () => [{ path: "films/:filmKey", element: <FilmDialog /> }];
const router = createBrowserRouter([
  {
    path: "/",
    loader: bootstrap,
    element: <Root />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <Loading />,
    children: [
      { index: true, element: <IndexRedirect /> },
      { path: "schedule", element: <Outlet />, children: filmRoute() },
      {
        path: "library",
        element: <LibraryPage key="library" />,
        children: filmRoute(),
      },
      {
        path: "picks",
        element: <LibraryPage key="picks" picked />,
        children: filmRoute(),
      },
      { path: "agenda", element: <AgendaPage />, children: filmRoute() },
      { path: "redblack", element: <RedBlackPage />, children: filmRoute() },
      { path: "rush", element: <RushPage />, children: filmRoute() },
      // 数据分析(2026-09-20,PLAN-20260920161837;同日由「抢票分析」更名见 PLAN-20260920193032):
      // 与 /rush 并列的第二张票务视图。
      //
      // ⚠ **本页刻意走路由级动态 import**(仓库里唯一一处):它带了 ECharts(原为 recharts),
      //   实测 gzip 193.9 KB —— 比整个主包(82.5 KB)还大一倍多。
      //   而首屏(排片表)是电影节现场**断网也要能打开**的主路径,两者不该共担加载成本。
      //   走 `lazy` 之后 chart chunk 只在真正进入这一页时才下载,主包增量只有 2 B。
      //   (2026-09-20,PLAN-20260920203010 第 1 轮 + 同日修订 4 换 ECharts)
      //   (2026-09-20,PLAN-20260920203010 第 1 轮;实测数字见该 PLAN 的修订段)
      {
        path: "rush-analysis",
        lazy: async () => ({
          Component: (await import("./pages/RushAnalysisPage")).RushAnalysisPage,
        }),
        children: filmRoute(),
      },
      { path: "eats", element: <EatsPage /> },
      { path: "feedback", element: <FeedbackPage /> },
      {
        path: "*",
        element: (
          <div className="empty-state">
            <h1>找不到这个页面</h1>
            <a href="/schedule">返回排片表</a>
          </div>
        ),
      },
    ],
  },
]);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
