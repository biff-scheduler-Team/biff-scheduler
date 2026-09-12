import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { loadCatalog } from "../data";
import { loadExtras } from "../extras";
import { loadIntros } from "../intros";
import { loadRelated } from "../related";
import {
  allCodes,
  agendaFolded,
  gvTalk,
  gvTalkMinOv,
  loadAgendaFold,
  loadGvTalk,
  loadGvTalkMin,
  loadMappings,
  loadPicks,
  loadRanks,
  loadSavedPlans,
  loadSettings,
  notify,
  rankOf,
  savedPlans,
  store,
  subscribe,
} from "../state";
import { computeConflicts } from "../conflict";
import { buildPlanSet } from "../plans";
import { effEndMin, talkOnOf } from "../gv";
import { filmNodeKey, hmsToMin } from "../util";
import { buildFilms } from "./model";
import type { Catalog } from "../types";

let revision = 0;
subscribe(() => {
  revision++;
});
const getSnapshot = () => revision;
export function useStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function hydrateStorage(cat: Catalog) {
  store.picks.clear();
  rankOf.clear();
  gvTalk.clear();
  gvTalkMinOv.clear();
  agendaFolded.clear();
  savedPlans.length = 0;
  store.settings = {
    alarmMin: 45,
    transitMin: 0,
    gvTalkOn: true,
    gvTalkMin: 25,
  };
  loadSettings();
  loadGvTalk();
  loadGvTalkMin();
  // Legacy boot loads ranks before picks so rebuilding the index prunes stale ranks.
  loadRanks();
  loadSavedPlans();
  loadAgendaFold();
  loadPicks((code) => {
    const s = cat.byCode.get(code);
    return s ? filmNodeKey(cat, s) : null;
  });
  notify();
}
let pending: Promise<Catalog> | undefined;
export function bootstrap(): Promise<Catalog> {
  if (!pending)
    pending = (async () => {
      const cat = await loadCatalog();
      hydrateStorage(cat);
      await Promise.all([
        loadMappings(),
        loadExtras(),
        loadRelated(),
        loadIntros(),
      ]);
      return cat;
    })().catch((error) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

function derive(cat: Catalog) {
  const codes = allCodes().filter((c) => cat.byCode.has(c));
  const keyOf = (code: string) => {
    const s = cat.byCode.get(code);
    return s ? filmNodeKey(cat, s) : null;
  };
  const conflicts = computeConflicts(
    codes.map((code) => {
      const s = cat.byCode.get(code)!;
      return {
        code,
        date: s.date,
        start: hmsToMin(s.start_time),
        end: effEndMin(s, talkOnOf(code)),
        venue: s.venue_id,
      };
    }),
    () => store.settings.transitMin,
  );
  const plans = buildPlanSet(
    codes,
    conflicts,
    rankOf,
    (c) => hmsToMin(cat.byCode.get(c)!.start_time),
    keyOf,
  );
  const films = buildFilms(cat, store.mappings);
  return {
    cat,
    codes,
    keyOf,
    conflicts,
    plans,
    films,
    filmByKey: new Map(films.map((f) => [f.key, f])),
    conflictCount: [...conflicts.values()].reduce(
      (sum, c) => sum + c.pairs.length,
      0,
    ),
  };
}
const AppContext = createContext<ReturnType<typeof derive> | null>(null);
export function CatalogProvider({
  cat,
  children,
}: {
  cat: Catalog;
  children: ReactNode;
}) {
  const version = useStore();
  // The legacy store is mutable. Its revision invalidates all derived projections.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(() => derive(cat), [cat, version]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
export function useCatalog() {
  const value = useContext(AppContext);
  if (!value) throw new Error("CatalogProvider is missing");
  return value;
}
