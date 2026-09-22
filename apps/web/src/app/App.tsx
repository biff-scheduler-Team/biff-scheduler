import { initAccount } from "../account";
import { AccountHost } from "../components/AccountHost";
import { ScheduleSelectionProvider } from "./schedule-selection";
import { HighlightProvider } from "./highlight";
import {
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type CSSProperties,
} from "react";
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
  ActionMenu,
  DialogContainer,
  DialogTrigger,
  MenuItem,
  ToastContainer,
} from "../components/spectrum";
import { SettingsDialog } from "../components/SettingsDialog";
import { ExportDialog } from "../components/ExportDialog";
import {
  GuideDialog,
  TicketDialog,
  TicketLabel,
} from "../components/InfoDialogs";
import { UpdateBanner } from "../components/UpdateBanner";
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
  // ⚠ 白名单必须逐个列出:`rush-analysis` 与已下线的 `/rush` 曾经是两项(`rush` 后面跟的是
  //   `(?:\/|$)`),`/rush` 已于 2026-09-22 下线(`PLAN-20260922102751`),现在只剩 `rush-analysis`。
  //   漏加会让分析页被渲染进浮动面板布局(而不是整页)。
  const fullPage =
    /^\/(library|feedback|rush-analysis|redblack|eats)(?:\/|$)/.test(location.pathname) ||
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
  // 顶部辅助区收纳(2026-09-22,`PLAN-20260922105228`):「导出与分享 / 说明 / 设置」从三个并排的
  // 文字按钮收进一个「更多」菜单。菜单项与弹层之间只能靠**状态**连线 —— 弹层不再挂在各自的
  // `DialogTrigger` 上,而是按需挂进 `DialogContainer`(仓库先在 `pages/FilmDialog.tsx` 用过这条路径)。
  const [exportOpen, setExportOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // ⚠ 类型从组件本身推(`ComponentRef`),不要手写 `useRef<HTMLButtonElement>`:
  //   S2 的 `ActionMenu` 收的是 `FocusableRefValue`(带 `UNSAFE_getDOMNode`),普通 DOM ref 不赋得上。
  const headerMore = useRef<ComponentRef<typeof ActionMenu> | null>(null);
  /** 关掉顶部弹层:先收起,再把焦点**交回「更多」触发件**。
   *  为什么必须显式交回:弹层是从**菜单项**打开的,而关弹层时那个菜单早就卸载了 ——
   *  不交回,焦点会掉到 `<body>` 上,键盘用户当场失去位置。
   *  e2e「keyboard can open and dismiss a dialog, restoring focus」守这一条。 */
  const closeHeaderDialog = (setOpen: (next: boolean) => void) => () => {
    setOpen(false);
    headerMore.current?.focus();
  };
  const openHeaderAction = (key: string) => {
    // 每次打开都换 key → 重挂载弹层,读到的都是当下的设置 / 行程(与原先 DialogTrigger 的
    // onOpenChange + session 计数同一手法,见 `components/TransferAddDialog.tsx`)。
    if (key === "export") {
      setExportSession((n) => n + 1);
      setExportOpen(true);
    } else if (key === "guide") {
      setGuideOpen(true);
    } else if (key === "settings") {
      setSettingsSession((n) => n + 1);
      setSettingsOpen(true);
    }
  };
  // 页面浏览 + 点击采集（无 consent UI：用户 2026-09-20 明确「直接上报，不需要提示」）
  useTelemetryTracking();
  const nav = [
    ["/schedule", "排片表"],
    ["/library", "影片库"],
    ["/picks", "我的选片"],
    ["/agenda", "我的行程"],
    // 下面四项的顺序是用户 2026-09-22 指定的(`PLAN-20260922102751`);「抢票」页也在这一轮下线,
    // 导航不再有它(原来它夹在「我的行程」与「建议」之间)。
    // 「红黑榜」是**观影之后**的动作(2026-09-16,`PLAN-20260916102339`),原先排末尾,现上移。
    ["/redblack", "红黑榜"],
    // 「吃喝」与选片 / 观影 / 复盘那条主线无关(电影节期间吃哪儿),
    // 保持与「红黑榜」相邻的相对关系(2026-09-16,`PLAN-20260916232230`)。
    ["/eats", "吃喝"],
    // 「数据分析」原先紧跟「抢票」(2026-09-20,`PLAN-20260920161837`:同一票务主题的第三站);
    // 抢票下线后它收在后两位 —— 它是「预判 / 复盘」视图,与选片 → 观影不是同一段。
    // ⚠ 显示名叫「数据分析」而不是「抢票分析」(2026-09-20,`PLAN-20260920193032`,用户要求):
    //   这一页读的不止抢票,还有想看 / 红黑票 / 我的观影画像 / 影片构成 —— 旧名字窄了。
    //   路由 `/rush-analysis` 不动:它是书签 / PWA 缓存 / TEST-MAP 的契约,改名只落在显示层。
    ["/rush-analysis", "数据分析"],
    ["/feedback", "建议"],
  ];
  return (
    <Provider
      locale="zh-CN"
      colorScheme={dark ? "dark" : "light"}
      background="base"
      router={{ navigate, useHref: useAppHref }}
    >
      {/* 贴在整页最顶部(在 .app-header 之上):它是「这次打开看到的可能不是最新版」的提示,
          放在页脚或右下角都会错过。可见性由 CSS 的 sticky 负责。 */}
      <UpdateBanner />
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
          <DataUpdateButton />
          {conflictCount > 0 && (
            <ActionButton onPress={() => navigate(`/agenda${searchFor("/agenda")}`)}>
              重叠 {conflictCount}
            </ActionButton>
          )}
          {/* ⚠ 菜单项顺序 = 原来三个按钮的顺序(导出与分享 / 说明 / 设置),别顺手按字母重排 */}
          <ActionMenu ref={headerMore} aria-label="更多" onAction={(key) => openHeaderAction(String(key))}>
            <MenuItem id="export">
              <span data-track="export">导出与分享</span>
            </MenuItem>
            <MenuItem id="guide">说明</MenuItem>
            <MenuItem id="settings">设置</MenuItem>
          </ActionMenu>
        </div>
      </header>
      {/* 售票信息从 top bar 移出(2026-09-22,`PLAN-20260922105228`,用户「避免占用 Top Bar 的黄金位置」):
          改成头部下方一条独立通知条。⚠ 触发件与弹层**原样保留** —— 可访问名(「距第 N 批开票」/
          「BIFF 2026 售票中」)与「购票信息」弹层一字未改,只是换了宿主,既有断言不受影响。 */}
      <div className="ticket-banner">
        <span className="ticket-banner-label">票务</span>
        <DialogTrigger>
          {/* `size="S"`:这是一条**状态**提示,不是主操作 —— 用小一号按钮能把通知条压到 ~28px,
              给下面真正的内容让出高度(2026-09-22,`PLAN-20260922105228`) */}
          <ActionButton size="S">
            <TicketLabel />
          </ActionButton>
          <TicketDialog />
        </DialogTrigger>
      </div>
      {exportOpen && (
        <DialogContainer onDismiss={closeHeaderDialog(setExportOpen)}>
          <ExportDialog key={exportSession} />
        </DialogContainer>
      )}
      {guideOpen && (
        <DialogContainer onDismiss={closeHeaderDialog(setGuideOpen)}>
          <GuideDialog />
        </DialogContainer>
      )}
      {settingsOpen && (
        <DialogContainer onDismiss={closeHeaderDialog(setSettingsOpen)}>
          <SettingsDialog key={settingsSession} />
        </DialogContainer>
      )}
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
