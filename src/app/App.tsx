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
  ToggleButton,
} from "../components/spectrum";
import { SettingsDialog } from "../components/SettingsDialog";
import { ExportDialog } from "../components/ExportDialog";
import {
  GuideDialog,
  TicketDialog,
  TicketLabel,
} from "../components/InfoDialogs";
import { SchedulePage } from "../pages/SchedulePage";
import { CatalogProvider, hydrateStorage, useCatalog } from "./store";
import { useMedia } from "./hooks";
import { setSettings, store } from "../state";
import type { Catalog } from "../types";

// React Router resolves app paths; absolute external links must keep their scheme.
function useAppHref(href: string) {
  const external = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href);
  const resolved = useHref(external ? "/" : href);
  return external ? href : resolved;
}

export function IndexRedirect() {
  const mobile = useMedia("(max-width: 1099px)");
  return (
    <Navigate
      replace
      to={!mobile && store.picks.size ? "/agenda" : "/schedule"}
    />
  );
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
function Shell() {
  const { cat, conflictCount, codes } = useCatalog();
  const navigate = useNavigate();
  const location = useLocation();
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const small = useMedia("(max-width: 1099px)");
  const theme = store.settings.theme ?? "system";
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const panelOpen = /^\/(library|picks|agenda)(\/|$)/.test(location.pathname);
  const [width, setWidth] = useState(readWidth);
  const widthRef = useRef(width);
  widthRef.current = width;
  const drag = useRef<{ start: number; width: number } | null>(null);
  const aside = useRef<HTMLElement>(null);
  const persistWidth = (n: number | null) => {
    setWidth(n);
    try {
      if (n === null) localStorage.removeItem("biff.pickerw.v1");
      else localStorage.setItem("biff.pickerw.v1", String(n));
    } catch {
      /* Session width remains usable when storage is unavailable. */
    }
  };
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
      )
        navigate(`/schedule${location.search}`);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [panelOpen, navigate, location.search]);
  const [settingsSession, setSettingsSession] = useState(0);
  const [exportSession, setExportSession] = useState(0);
  const nav = [
    ["/schedule", "排片表"],
    ["/library", "影片库"],
    ["/picks", `我的选片${store.picks.size ? ` ${store.picks.size}` : ""}`],
    ["/agenda", `我的行程${codes.length ? ` ${codes.length}` : ""}`],
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
          <RouterLink to="/legacy/" reloadDocument className="version-link">
            回到旧版
          </RouterLink>
          <DialogTrigger>
            <ActionButton>
              <TicketLabel />
            </ActionButton>
            <TicketDialog />
          </DialogTrigger>
          {conflictCount > 0 && (
            <ActionButton onPress={() => navigate(`/agenda${location.search}`)}>
              重叠 {conflictCount}
            </ActionButton>
          )}
          <DialogTrigger
            onOpenChange={(open) => {
              if (open) setExportSession((n) => n + 1);
            }}
          >
            <ActionButton>导出与分享</ActionButton>
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
              to={`${path}${location.search}`}
              className={({ isActive }) =>
                isActive ? "nav-item active" : "nav-item"
              }
            >
              {text}
            </NavLink>
          ))}
        </nav>
        <div className="theme-controls" aria-label="外观">
          {(["system", "light", "dark"] as const).map((t) => (
            <ToggleButton
              key={t}
              isSelected={theme === t}
              onChange={() => setSettings({ theme: t })}
            >
              {t === "system" ? "系统" : t === "light" ? "亮色" : "暗色"}
            </ToggleButton>
          ))}
        </div>
      </div>
      <main
        id="workspace"
        className={`workspace ${panelOpen ? "with-panel" : ""}`}
        style={
          width
            ? ({ "--panel-width": `${width}px` } as CSSProperties)
            : undefined
        }
      >
        {panelOpen ? (
          <>
            <aside className="side-panel panel" ref={aside}>
              <div className="panel-close">
                <ActionButton
                  onPress={() => navigate(`/schedule${location.search}`)}
                  aria-label="收起选片面板"
                >
                  收起
                </ActionButton>
              </div>
              <Outlet />
            </aside>
            {!small && (
              <div
                className="panel-resizer"
                role="separator"
                aria-label="调整选片面板宽度"
                aria-orientation="vertical"
                aria-valuemin={520}
                aria-valuemax={800}
                aria-valuenow={
                  width ?? Math.round(aside.current?.clientWidth ?? 520)
                }
                tabIndex={0}
                onDoubleClick={() => persistWidth(null)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    persistWidth(
                      Math.max(
                        520,
                        Math.min(
                          800,
                          (width ?? aside.current?.clientWidth ?? 520) +
                            (e.key === "ArrowLeft" ? -20 : 20),
                        ),
                      ),
                    );
                  }
                  if (e.key === "Home") persistWidth(520);
                  if (e.key === "End") persistWidth(800);
                }}
                onPointerDown={(e) => {
                  drag.current = {
                    start: e.clientX,
                    width: aside.current?.clientWidth ?? 520,
                  };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (drag.current)
                    setWidth(
                      Math.max(
                        520,
                        Math.min(
                          800,
                          Math.round(
                            drag.current.width + e.clientX - drag.current.start,
                          ),
                        ),
                      ),
                    );
                }}
                onPointerUp={() => {
                  if (drag.current) persistWidth(widthRef.current);
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
              >
                <span />
              </div>
            )}
          </>
        ) : (
          <Outlet />
        )}
        <div className="schedule-column">
          <SchedulePage />
        </div>
      </main>
      <footer className="app-footer">
        BIFF {cat.schedule.festival.year}，釜山国际电影节{" "}
        <span>数据保存在当前浏览器</span>
      </footer>
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
