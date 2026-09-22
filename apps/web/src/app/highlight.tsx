import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { conflictGroupFor } from "../conflict";
import { useCatalog } from "./store";

const HighlightContext = createContext({
  /** 当前高亮的那一场(`null` = 没有) —— 「我的行程」侧栏的场次详情用它,见 `AgendaPage`。 */
  code: null as string | null,
  /** 高亮场次 + 它所在冲突组(画布据此一起提亮)。 */
  codes: new Set<string>(),
  setCode: (_code: string | null) => {},
});
export function HighlightProvider({ children }: { children: ReactNode }) {
  const { cat, conflicts } = useCatalog();
  const [code, setCode] = useState<string | null>(null);
  const codes = useMemo(() => {
    if (!code) return new Set<string>();
    const s = cat.byCode.get(code);
    return (
      (s && conflictGroupFor(conflicts.get(s.date), code)) || new Set([code])
    );
  }, [cat, code, conflicts]);
  // ⚠ `code` 与 `codes` 是**同一处实现**的两个视图(前者是"哪一场",后者是"哪几场要一起亮"),
  //   2026-09-22 为了让行程侧栏能显示「当前指着的那一场」才补上 `code`(`PLAN-20260922105228`)——
  //   别在这里另起一套 hover 状态,画布与侧栏必须看同一个来源。
  return (
    <HighlightContext.Provider value={{ code, codes, setCode }}>
      {children}
    </HighlightContext.Provider>
  );
}
export function useHighlight() {
  return useContext(HighlightContext);
}
