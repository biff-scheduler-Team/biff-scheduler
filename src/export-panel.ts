// 导出 / 分享弹层 —— **先选方案,再选导出成什么**(2026-09-12)。
//
// ★ 为什么单开一个弹层:导出 / 分享从「全部已排场次」改成「按**已保存方案**导出」之后,
//   入口不再是一个动作,而是一个**两段选择**(哪个方案 × 哪种出口)—— 下拉菜单放不下这层结构。
//   「导出数据备份 / 导入数据备份」跟方案无关,继续留在原菜单里(见 `main.ts`)。
// ⚠ 没有任何已保存方案时,三个导出项禁用 + 提示「先保存一个方案」——
//   方案在「我的行程」顶部保存(见 `agenda.ts::buildSavedPlans`)。
//
// 口径(与 `.ics` / 分享文案 / 行程图同源,勿另起一套):
//   · 场次 = 方案快照里的 code(按日期 / 开场时间排序);备注按 code 反查当前行程(不在行程则为空);
//   · 时间 / 片名 / 映后谈取舍全部走既有出口函数(`buildIcs` / `buildShareText` / `openPosterModal`)。

import type { Catalog, Screening } from "./types";
import type { PickRow } from "./ics";
import { buildIcs, downloadIcs } from "./ics";
import { buildShareText } from "./share";
import { copyText } from "./clipboard";
import { savedPlans, store, type SavedPlan } from "./state";
import { openModal } from "./modal";
import { openPosterModal } from "./poster-panel";
import { dateInfo, el } from "./util";
import { toast } from "./toast";
import { BTN_GO_SM } from "./ui";

/** 方案快照 → 导出行(备注按 code 反查**当前行程**;已移出行程的场次备注为空) */
function rowsOf(plan: SavedPlan): PickRow[] {
  return plan.codes.map((code) => {
    const key = store.slotIndex.get(code)?.key;
    const note = key ? (store.picks.get(key)?.note ?? "") : "";
    return { code, note };
  });
}

/** 方案概要:`4 场 · OCT 11–OCT 12`(排期里查不到的 code 记「已不在排期」) */
function planOutline(cat: Catalog, plan: SavedPlan): string {
  const shows = plan.codes
    .map((c) => cat.byCode.get(c))
    .filter((s): s is Screening => Boolean(s))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
  const bits: string[] = [`${shows.length} 场`];
  if (shows.length) {
    const first = dateInfo(shows[0].date).label;
    const last = dateInfo(shows[shows.length - 1].date).label;
    bits.push(first === last ? first : `${first}–${last}`);
  }
  const gone = plan.codes.length - shows.length;
  if (gone > 0) bits.push(`${gone} 场已不在排期`);
  return bits.join(" · ");
}

/** 导出 / 分享弹层的入口 —— 由导出菜单的「导出 .ics / 分享文案 / 分享图片」三项统一进入。 */
export function openExportPanel(cat: Catalog, gvTalkOf: (code: string) => boolean): void {
  const body = el("div", "grid gap-[12px]");
  // 默认选**最新保存**的那套(数组末尾 = 最近一次「保存当前方案」)
  let selectedId: string | null = savedPlans.length ? savedPlans[savedPlans.length - 1].id : null;

  const planBox = el("div", "grid gap-[6px]");
  const acts = el("div", "flex items-center gap-[6px] flex-wrap");
  const hint = el("div", "text-11 text-muted");

  body.append(el("div", "text-13 font-bold text-ink", "选择方案"), planBox, acts, hint);
  paint();
  openModal("导出 · 分享", body, "md");

  /** 重绘方案列表 + 三个导出按钮的禁用态(选中项变化 / 方案增删后都走这里) */
  function paint(): void {
    planBox.replaceChildren();
    if (savedPlans.length === 0) {
      selectedId = null;
      hint.textContent =
        "还没有保存方案 —— 到「我的行程」顶部点「保存当前方案」存一个,再回来按方案导出。";
    } else {
      if (!selectedId || !savedPlans.some((p) => p.id === selectedId)) {
        selectedId = savedPlans[savedPlans.length - 1].id;
      }
      for (const p of savedPlans) planBox.appendChild(planRow(p));
      hint.textContent = "导出 / 分享只包含所选方案的场次;数据备份仍在「导出 · 分享」菜单里。";
    }
    paintActs();
  }

  function planRow(p: SavedPlan): HTMLElement {
    const on = p.id === selectedId;
    const row = el(
      "button",
      "w-full text-left border rounded-7 px-[9px] py-[6px] flex items-center gap-[8px] " +
        (on ? "border-biff bg-biff-soft" : "border-line bg-card hover:border-line-strong hover:bg-hover")
    );
    row.appendChild(el("span", `text-12 font-bold ${on ? "text-biff-ink" : "text-ink"} shrink-0`, p.name));
    row.appendChild(el("span", "text-11 text-muted flex-1 min-w-0 truncate tabular-nums", planOutline(cat, p)));
    if (on) row.appendChild(el("span", "text-11 font-extrabold text-biff-ink shrink-0", "✓ 已选"));
    row.addEventListener("click", () => {
      selectedId = p.id;
      paint();
    });
    return row;
  }

  function paintActs(): void {
    acts.replaceChildren();
    const plan = selectedId ? savedPlans.find((p) => p.id === selectedId) : undefined;
    const rows = plan ? rowsOf(plan) : [];

    const mk = (label: string, tip: string, run: () => void): HTMLElement => {
      const btn = el("button", BTN_GO_SM, label);
      btn.dataset.tip = tip;
      if (!plan || rows.length === 0) {
        btn.disabled = true;
        btn.className += " opacity-45 cursor-not-allowed";
      } else {
        btn.addEventListener("click", run);
      }
      return btn;
    };

    acts.append(
      mk("导出 .ics", "导入手机日历,自动按手机时区显示,含提前提醒", () => {
        if (!plan) return;
        const ics = buildIcs(cat, rows, store.mappings, store.settings.alarmMin, gvTalkOf);
        downloadIcs(ics, "biff2026.ics");
        toast(`已导出「${plan.name}」${rows.length} 场,导入日历后按手机时区显示`);
      }),
      mk("分享文案", "按「日期分节 + 两行一场」生成纯文本,粘贴到微信也读得清", () => {
        if (!plan) return;
        const text = buildShareText(cat, rows, store.mappings, gvTalkOf);
        void copyText(text).then((ok) =>
          toast(ok ? `已复制「${plan.name}」(${rows.length} 场),粘贴到微信即可` : "复制失败,请手动选择复制")
        );
      }),
      mk("分享图片", "生成一张深色行程长图(含影片海报),可复制到剪贴板或下载 PNG", () => {
        if (!plan) return;
        openPosterModal(cat, gvTalkOf, rows);
      })
    );
  }
}
