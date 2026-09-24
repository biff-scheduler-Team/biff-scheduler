import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { loadCatalog } from "../data";
import { loadChangelog } from "../changelog";
import { loadExtras } from "../extras";
import { loadIntros } from "../intros";
import { loadRelated } from "../related";
import {
  allCodes,
  agendaFolded,
  fillSoleShowPicks,
  gvTalk,
  gvTalkMinOv,
  loadAgendaFold,
  loadGvTalk,
  loadGvTalkMin,
  loadMappings,
  loadPicks,
  loadRanks,
  loadSettings,
  loadTicketInfo,
  loadTickets,
  notify,
  rankOf,
  registerSoleShows,
  store,
  subscribe,
  ticketInfo,
  tickets,
} from "../state";
import { loadTicketAccounts } from "../ticket-accounts";
import { loadScreeningCounts } from "../screening-counts";
import { computeConflicts } from "../conflict";
import { buildPlanSet } from "../plans";
import { effEndMin, talkOnOf } from "../gv";
import { withPni } from "../pni";
import { filmNodeKey, hmsToMin } from "../util";
import { buildFilmsCached, soleShowIndex } from "./model";
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
  tickets.clear();
  ticketInfo.clear();
  gvTalk.clear();
  gvTalkMinOv.clear();
  agendaFolded.clear();
  store.settings = {
    alarmMin: 45,
    transitMin: 0,
    gvTalkOn: true,
    gvTalkMin: 25,
    showPni: false,
  };
  loadSettings();
  loadGvTalk();
  loadGvTalkMin();
  // 旧版启动先载 ranks 再载 picks：这样重建索引时会顺手剔掉已失效的名次。
  loadRanks();
  // 票务状态同理:必须在 loadPicks 之前载入,否则 rebuildIndex() 会把整张表当成脏数据 prune 掉
  loadTickets();
  // 票据明细(张数 / 座位 / 账号)与三态同判据、同一个 prune 点,故同一条纪律
  loadTicketInfo();
  // 票务账号表:本地专属键(`iffday.workspace.*`),既不进同步也不进备份 —— 这里只读一次。
  loadTicketAccounts();
  loadAgendaFold();
  loadPicks((code) => {
    const s = cat.byCode.get(code);
    return s ? filmNodeKey(cat, s) : null;
  });
  // ★「只有一场」的影片:选定 = 排定(2026-09-16,`PLAN-20260916004024`)。
  //   判据在这里注入一次 —— 移除口径(`state.ts::toggleScreening`)与影片库入口都用它,
  //   免得网格 / 选片卡 / 行程卡各判一次「这算不算单场片」。
  //   随后补齐:单场影片若在选片清单里却没场次(旧版本只建了空记录)→ 直接排上那一场。
  const sole = soleShowIndex(cat);
  registerSoleShows((key) => sole.get(key)?.code ?? null);
  fillSoleShowPicks();
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
        // 同场观影人数:整站一次拉取(场次卡要用),失败静默降级为空表
        // (接口还会回 `discussions`,但前端自 2026-09-22 起不再消费 —— 见 `screening-counts.ts`)
        loadScreeningCounts(),
        // 排期数据更新日志:缺文件 / 旧部署时静默降级,顶栏不出现「数据更新」入口
        loadChangelog(),
      ]);
      return cat;
    })().catch((error) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

function derive(base: Catalog) {
  // P&I(Press & Industry)记者 / 业界场**默认不显示**;设置里勾选「显示 P&I 场次」后才并进来。
  // 合并点只此一处:冲突 / 网格 / 片单 / 行程 / 导出 / 抢票读的都是这份 catalog,自动一致 ——
  // 不必在每个视图里各判一次「这场算不算 P&I」(那就是第二份口径)。纯函数,见 `pni.ts`。
  const cat = store.settings.showPni ? withPni(base) : base;
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
  // films 只依赖目录 + 豆瓣映射，与选片无关 —— 走带缓存的版本，
  // 免得「点一场片」就把整届 795 场重算一遍（2026-09-23，`PLAN-20260923113659` T3）
  const films = buildFilmsCached(base, cat, store.mappings, store.mappingRevision);
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
  // 旧 store 是**原地变更**的可变对象，只能靠版本号让所有派生结果失效重算。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(() => derive(cat), [cat, version]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
export function useCatalog() {
  const value = useContext(AppContext);
  if (!value) throw new Error("CatalogProvider is missing");
  return value;
}
