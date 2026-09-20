import { initAccount } from "../account";
import { AccountHost } from "../components/AccountHost";
import { ScheduleSelectionProvider } from "./schedule-selection";
import { HighlightProvider } from "./highlight";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  NavLink,
  Link as RouterLink,
  Navigate,
  Outlet,
  useHref,
  useLoaderData,
  useLocation,
  useNavigate,
  useRouteError,
} from "react-router";
import { Provider } from "@react-spectrum/s2/Provider";
import {
  ActionButton,
  DialogTrigger,
  ToastContainer,
} from "../components/spectrum";
import { SettingsDialog } from "../components/SettingsDialog";
import { ExportDialog } from "../components/ExportDialog";
import {
  GuideDialog,
  TicketDialog,
  TicketLabel,
} from "../components/InfoDialogs";
import { DataUpdateButton } from "../components/ChangelogDialog";
import { SchedulePage } from "../pages/SchedulePage";
import { navSearch } from "./nav-query";
import { CatalogProvider, hydrateStorage, useCatalog } from "./store";
import { useMedia } from "./hooks";
// 全站事件采集（2026-09-20，第 3 轮，PLAN-20260920203010 修订 2）：
// 挂在这里是因为**本组件是唯一同时拿到路由位置与全站点击的壳**。
import { useTelemetryTracking } from "../telemetry";
import { store } from "../state";
import type { Catalog } from "../types";

// React Router resolves app paths; absolute external links must keep their scheme.
function useAppHref(href: string) {
  const external = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href);
  const resolved = useHref(external ? "/" : href);
  return external ? href : resolved;
}

export function IndexRedirect() {
  const location = useLocation();
  return <Navigate replace to={`/schedule${location.search}`} />;
}
function readWidth() {
  try {
    const n = Number(localStorage.getItem("biff.pickerw.v1"));
    return Number.isFinite(n) && n > 0
      ? Math.min(800, Math.max(520, Math.round(n)))
      : null;
  } catch {
    return null;
  }
}
let accountInitialized = false;
function Shell() {
  const navigate = useNavigate();
  const { cat, conflictCount, codes, filmByKey } = useCatalog();
  useEffect(() => {
    if (accountInitialized) return;
    accountInitialized = true;
    void initAccount(() => hydrateStorage(cat), key => filmByKey.get(key)?.title ?? key, url => navigate(`${url.pathname}${url.search}`, {replace: true}));
  }, [cat, filmByKey, navigate]);
  const location = useLocation();
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const theme = store.settings.theme ?? "system";
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const viewingRoute = /^\/(picks|agenda)(\/|$)/.test(location.pathname);
  const panelOpen = viewingRoute && new URLSearchParams(location.search).get("quick") === "1";
  // ⚠ 白名单必须逐个列出:`rush` 后面跟的是 `(?:\/|$)`,所以 `/rush-analysis` **不会**被它匹配到 ——
  //   漏加会让分析页被渲染进浮动面板布局(而不是整页)。
  const fullPage =
    /^\/(library|feedback|discussions|rush-analysis|rush|redblack|eats)(?:\/|$)/.test(location.pathname) ||
    (viewingRoute && !panelOpen);
  // 查询串**口径唯一来源** = `app/nav-query.ts`:同名 key 不跨页(`q` 在影片库 / 红黑榜 / 吃喝
  // 各有一份语义),只有排片表的 `date` / `hour` 跟着走。原先这里只剔掉 `quick` 就整条搬过去,
  // 于是「影片库搜 Midnight Passion」会出现在吃喝的搜索框里(见 `PLAN-20260917002528`)。
  const searchFor = (path: string) => navSearch(location.search, location.pathname, path);
  const scheduleSearch = searchFor("/schedule");
  // 同页导航(浮动面板「打开完整页面」)沿用本页 search,语义与改动前一致
  const pageSearch = searchFor(location.pathname);
  const floatButton = useRef<HTMLButtonElement>(null);
  const lastPanel = useRef("/agenda");
  if (panelOpen) lastPanel.current = location.pathname.startsWith("/picks") ? "/picks" : "/agenda";
  const [width, setWidth] = useState(readWidth);
  const aside = useRef<HTMLElement>(null);
  useEffect(() => {
    if (panelOpen && !aside.current?.contains(document.activeElement) && !document.querySelector('[role="dialog"]')) aside.current?.querySelector<HTMLElement>("a.active,button")?.focus({preventScroll: true});
  }, [panelOpen]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.colorScheme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (!e.key || e.key.startsWith("biff.")) {
        hydrateStorage(cat);
        setWidth(readWidth());
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [cat]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        panelOpen &&
        !document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="listbox"]',
        )
      ) {
        navigate(`/schedule${scheduleSearch}`);
        floatButton.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [panelOpen, navigate, scheduleSearch]);
  const [settingsSession, setSettingsSession] = useState(0);
  const [exportSession, setExportSession] = useState(0);
  // 页面浏览 + 点击采集（无 consent UI：用户 2026-09-20 明确「直接上报，不需要提示」）
  useTelemetryTracking();
  const nav = [
    ["/schedule", "排片表"],
    ["/library", "影片库"],
    ["/picks", "我的选片"],
    ["/agenda", "我的行程"],
    // 「抢票」刻意排在「我的行程」之后、「建议」之前(2026-09-15 用户指定):
    // 它读的是行程里的场次,按开票批次重新分组 —— 是行程的「开票期」视图,不是另一份数据。
    ["/rush", "抢票"],
    // 「数据分析」紧跟「抢票」之后(2026-09-20,PLAN-20260920161837):同一票务主题的第三站 ——
    // 行程(选片期)→ 抢票(开票当天)→ 数据分析(预判 / 复盘);读的是同一份数据,故不拆到导航别处。
    // ⚠ 显示名叫「数据分析」而不是「抢票分析」(2026-09-20,PLAN-20260920193032,用户要求):
    //   这一页读的不止抢票,还有想看 / 红黑票 / 我的观影画像 / 影片构成 —— 旧名字窄了。
    //   路由 `/rush-analysis` 不动:它是书签 / PWA 缓存 / TEST-MAP 的契约,改名只落在显示层。
    ["/rush-analysis", "数据分析"],
    ["/feedback", "建议"],
    ["/discussions", "讨论区"],
    // 「红黑榜」排在末尾(2026-09-16,PLAN-20260916102339):它是**观影之后**的动作,
    // 与「抢票」那种行程期视图不同序 —— 不动 2026-09-15 用户指定的抢票位置。
    ["/redblack", "红黑榜"],
    // 「吃喝」跟在红黑榜之后(2026-09-16,PLAN-20260916232230):它是**与选片完全无关**的
    // 第二份刚需(电影节期间吃哪儿),不属于选片 → 观影 → 复盘这条主线,所以放最后。
    ["/eats", "吃喝"],
  ];
  return (
    <Provider
      locale="zh-CN"
      colorScheme={dark ? "dark" : "light"}
      background="base"
      router={{ navigate, useHref: useAppHref }}
    >
      <a className="skip-link" href="#workspace">
        跳到主要内容
      </a>
      <header className="app-header">
        <NavLink to="/schedule" className="brand">
          <img src="/brand/biff-scheduler-wordmark.svg" alt="BIFF Scheduler" />
        </NavLink>
        <div className="header-actions">
          <button id="account-btn" type="button" className="version-link">登录 IFFDAY</button>
          <span id="account-sync-status" className="muted" role="status" />
          <RouterLink to="/legacy/" reloadDocument className="version-link">
            回到旧版
          </RouterLink>
          <DialogTrigger>
            <ActionButton>
              <TicketLabel />
            </ActionButton>
            <TicketDialog />
          </DialogTrigger>
          <DataUpdateButton />
          {conflictCount > 0 && (
            <ActionButton onPress={() => navigate(`/agenda${searchFor("/agenda")}`)}>
              重叠 {conflictCount}
            </ActionButton>
          )}
          <DialogTrigger
            onOpenChange={(open) => {
              if (open) setExportSession((n) => n + 1);
            }}
          >
            <ActionButton>
              <span data-track="export">导出与分享</span>
            </ActionButton>
            <ExportDialog key={exportSession} />
          </DialogTrigger>
          <DialogTrigger>
            <ActionButton aria-label="日程表说明">说明</ActionButton>
            <GuideDialog />
          </DialogTrigger>
          <DialogTrigger
            onOpenChange={(open) => {
              if (open) setSettingsSession((n) => n + 1);
            }}
          >
            <ActionButton>设置</ActionButton>
            <SettingsDialog key={settingsSession} />
          </DialogTrigger>
        </div>
      </header>
      <div className="app-toolbar">
        <nav className="main-nav" aria-label="主要导航">
          {nav.map(([path, text]) => (
            <NavLink
              key={path}
              to={`${path}${searchFor(path)}`}
              className={({ isActive }) =>
                (panelOpen ? path === "/schedule" : isActive) ? "nav-item active" : "nav-item"
              }
            >
              {text}
            </NavLink>
          ))}
        </nav>

      </div>
      <main
        id="workspace"
        className={`workspace floating-workspace ${fullPage ? "full-page-workspace" : ""}`}
        style={
          width
            ? ({ "--panel-width": `${width}px` } as CSSProperties)
            : undefined
        }
      >
        {panelOpen ? (
          <>
            <aside id="viewing-panel" aria-label="我的观影" className="side-panel panel viewing-panel" ref={aside}>
              <div className="panel-close viewing-panel-heading">
                <nav aria-label="我的观影视图" className="viewing-tabs">
                  <NavLink to={`/picks${location.search}`}>我的选片 {store.picks.size}</NavLink>
                  <NavLink to={`/agenda${location.search}`}>我的行程 {codes.length}</NavLink>
                </nav>
                <RouterLink className="viewing-full-link" to={`${location.pathname.split("/films/")[0]}${pageSearch}`}>打开完整页面</RouterLink>
                <ActionButton
                  onPress={() => { navigate(`/schedule${scheduleSearch}`); floatButton.current?.focus(); }}
                  aria-label="收起选片面板"
                >
                  收起
                </ActionButton>
              </div>
              <Outlet />
            </aside>

          </>
        ) : (
          <Outlet />
        )}
        <div className="schedule-column" hidden={fullPage}>
          <SchedulePage />
        </div>
      </main>
      <button
        ref={floatButton}
        hidden={fullPage}
        className="viewing-fab"
        type="button"
        aria-label={panelOpen ? "收起我的观影" : "打开我的观影"}
        aria-expanded={panelOpen}
        aria-controls="viewing-panel"
        onClick={() => {
          if (panelOpen) navigate(`/schedule${scheduleSearch}`);
          else {
            const params = new URLSearchParams(searchFor(lastPanel.current));
            params.set("quick", "1");
            navigate(`${lastPanel.current}?${params}`);
          }
        }}
      >
        {panelOpen ? "收起" : `我的观影${codes.length ? ` ${codes.length}` : ""}`}
      </button>
      <footer className="app-footer">
        <span>BIFF {cat.schedule.festival.year}，釜山国际电影节</span>
        <span>数据保存在当前浏览器</span>
        <span className="app-footer-credits">
          by{" "}
          <a href="https://github.com/gaaiyeoi" target="_blank" rel="noopener noreferrer">
            @gaaiyeoi
          </a>{" "}
          和 by{" "}
          <a href="https://github.com/lcandy2" target="_blank" rel="noopener noreferrer">
            @citron
          </a>
        </span>
      </footer>
      <AccountHost />
      <ToastContainer />
    </Provider>
  );
}
export function Root() {
  const cat = useLoaderData() as Catalog;
  return (
    <CatalogProvider cat={cat}>
      <ScheduleSelectionProvider>
        <HighlightProvider>
          <Shell />
        </HighlightProvider>
      </ScheduleSelectionProvider>
    </CatalogProvider>
  );
}
export function Loading() {
  return (
    <div className="app-loading" role="status">
      <img src="/brand/biff-scheduler-seal.svg" alt="" />
      <h1>正在载入电影节排期</h1>
      <p>正在读取影片与影厅信息。</p>
    </div>
  );
}
export function RouteError() {
  const error = useRouteError();
  return (
    <div className="app-loading" role="alert">
      <h1>排期加载失败</h1>
      <p>{error instanceof Error ? error.message : "页面暂时无法打开。"}</p>
      <p>检查网络连接后重试。</p>
      <a href="/">重新加载</a>
    </div>
  );
}
