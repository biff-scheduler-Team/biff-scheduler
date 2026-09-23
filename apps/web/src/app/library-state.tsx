import { useEffect, useSyncExternalStore } from "react";

type LibraryTab = "library" | "picks";
let expanded: Record<LibraryTab, ReadonlySet<string>> = {
  library: new Set(),
  picks: new Set(),
};
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setFilmExpanded(tab: LibraryTab, key: string, open: boolean) {
  const next = new Set(expanded[tab]);
  if (open) next.add(key);
  else next.delete(key);
  expanded = { ...expanded, [tab]: next };
  listeners.forEach((listener) => listener());
}

/** 选片器打开期间两个标签都留着 —— 与旧版抽屉的关闭行为一致。 */
export function useLibraryExpansion(tab: LibraryTab) {
  const value = useSyncExternalStore(subscribe, () => expanded[tab]);
  useEffect(() => () => {
    if (/^\/(library|picks|agenda)(\/|$)/.test(window.location.pathname)) return;
    expanded = { library: new Set(), picks: new Set() };
    listeners.forEach((listener) => listener());
  }, []);
  return value;
}
