import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, Outlet } from "react-router";
import { bootstrap } from "./app/store";
import { IndexRedirect, Loading, Root, RouteError } from "./app/App";
import { LibraryPage } from "./pages/LibraryPage";
import { FeedbackPage } from "./pages/FeedbackPage";
import { DiscussionsPage } from "./pages/DiscussionsPage";
import { AgendaPage } from "./pages/AgendaPage";
import { RedBlackPage } from "./pages/RedBlackPage";
import { RushPage } from "./pages/RushPage";
import { FilmDialog } from "./pages/FilmDialog";
import "./style.css";

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
      { path: "feedback", element: <FeedbackPage /> },
      { path: "discussions", element: <DiscussionsPage /> },
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
