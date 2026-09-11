// 抢票顺位清单(复制到剪贴板)。
// 从 `main.ts` 拆出(2026-09-10,PLAN-20260910232833)。
// 依赖 `cat` 与 `gvTalkOf`(均为 main 的模块态)以参数注入,避免反向依赖 main。

import type { Catalog, Priority, Screening } from "./types";
import { dateInfo, displayTitle, fmtMinRangeMin, hmsToMin } from "./util";
import { effEndMin, gvTalkMin } from "./gv";
import { codesOfGroup, priorityOfCode, store } from "./state";
import { PRI_RANK } from "./pick";
import { priorityTag } from "./ics";
import { toast } from "./toast";

/* ---------------- §14 4b:抢票顺位清单(复制) ---------------- */
/** 顺位排序权重(必看 → 备选 → 随缘);未设档位(null)在清单里排备选位,不参与质量分 */
const rankOf = (p: Priority | null): number => (p ? PRI_RANK[p] : PRI_RANK.maybe);

export function copyPicklist(cat: Catalog, gvTalkOf: (code: string) => boolean): void {
  document.getElementById("export-menu")!.classList.add("is-hidden");
  const group = store.group;
  // 一场一行;档位来自影片级记录(同一部片的多场必然同档 —— 这正是「一套数据」)
  const rows: { code: string; priority: Priority | null; s: Screening }[] = [];
  for (const code of codesOfGroup(group)) {
    const s = cat.byCode.get(code);
    if (s) rows.push({ code, priority: priorityOfCode(code) ?? null, s });
  }
  if (rows.length === 0) {
    toast(`「${group} 方案」还没有选片,先在网格里点选场次`);
    return;
  }
  rows.sort(
    (a, b) =>
      rankOf(a.priority) - rankOf(b.priority) ||
      Number(Boolean(b.s.is_gv)) - Number(Boolean(a.s.is_gv)) ||
      a.s.date.localeCompare(b.s.date) ||
      a.s.start_time.localeCompare(b.s.start_time)
  );
  const cnt: Record<Priority, number> = { must: 0, maybe: 0, wild: 0 };
  let unset = 0;
  rows.forEach((r) => {
    if (r.priority == null) unset++;
    else cnt[r.priority]++;
  });

  const lines: string[] = [];
  lines.push(`【BIFF 2026 抢票顺位 · ${group} 方案】共 ${rows.length} 场`);
  lines.push(
    `必看 ${cnt.must} · 备选 ${cnt.maybe} · 随缘 ${cnt.wild}` +
      (unset ? ` · 未分级 ${unset}` : "") +
      "(同优先级 GV/映后优先,同日按开场时间)"
  );
  lines.push("──");
  rows.forEach(({ code, priority, s }, i) => {
    const { label, weekday } = dateInfo(s.date);
    const title = displayTitle(s, store.mappings.get(code)?.title_cn);
    // 有效结束 + GV 标记:含映后 / 仅正片(放弃)两种标注,转场口径与网格/行程一致
    const talk = gvTalkMin(s);
    const talkOn = talk > 0 ? gvTalkOf(code) : true;
    // 24+ 时制:跨午夜场终点折回 24h 内并带「次日」标记(如 "23:59–次日 05:35")
    const endMin = effEndMin(s, talkOn);
    const gvMark =
      talk > 0 ? (talkOn ? "(GV·含映后)" : "(GV·仅正片)") : s.is_gv ? "(GV)" : "";
    lines.push(
      `${i + 1}. [${priorityTag(priority)}] ${s.code} ${title} ${label} ${weekday} ${fmtMinRangeMin(hmsToMin(s.start_time), endMin)} ${s.venue_display}${gvMark}`
    );
  });
  void copyText(lines.join("\n")).then((ok) =>
    toast(ok ? `已复制抢票顺位清单(${rows.length} 场),按售票时段抢票` : "复制失败,请手动选择复制")
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* clipboard 权限拒绝时降级 execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
