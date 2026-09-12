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
  return (
    <HighlightContext.Provider value={{ codes, setCode }}>
      {children}
    </HighlightContext.Provider>
  );
}
export function useHighlight() {
  return useContext(HighlightContext);
}
