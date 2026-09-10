// 我的行程 — 按日期分组的议程列表:冲突标红、优先级/方案可直接切换。
// 与「我的选片」同一份数据(store.picks):本视图按场次展开,行内三段 seg 改的是**该片档位**(影片级)。
// 全量化:行程行 / 优先级三段 / chip / 转场间隔三态 全部 Tailwind utility。

import type { Catalog, Group, Mapping, PickEntry, Screening } from "./types";
import { OK_SLACK, dateInfo, el, escapeHtml, fmtEndClock, hmsToMin } from "./util";
import { effEndMin, filmEndMin, gvTalkMin } from "./gv";
import { gvTalkMinOv, store } from "./state";
import { codeTip } from "./badges";
import { appendMetaRow } from "./legend";
import { PRI_BG_ON, WISH_ORDER } from "./pick";
import type { ConflictResult } from "./conflict";

export interface AgendaCtx {
  cat: Catalog;
  /** 已选场次投影:code → { 影片 key, 方案 }(唯一数据源的场次视图) */
  slots: Map<string, { key: string; group: Group }>;
  /** 选片记录:影片 key → { 档位, 场次, 备注 }(档位 / 备注来自这里,全片一致) */
  picks: Map<string, PickEntry>;
  group: Group; // 当前展示方案
  mappings: Map<string, Mapping>;
  transitMin: number;
  /** GV 映后谈是否参加(全局默认 + 单场覆写解析后):决定本行有效区间 / 开关态 / 与上一场间隔 */
  gvTalkOf: (code: string) => boolean;
  conflicts: Map<string, ConflictResult>; // 当前方案全日期冲突
  /** C1:网格时间筛选(整点时段)联动 —— 当日同段行 slot-hit 高亮,当日不同段行 hour-dim 淡化 */
  slotDate?: string;
  slotHour?: number | null;
}

export function buildAgenda(ctx: AgendaCtx): HTMLElement {
  const wrap = el("div", "grid gap-[14px]");
  const codesOfGroup = [...ctx.slots.entries()].filter(([, v]) => v.group === ctx.group).map(([c]) => c);

  if (codesOfGroup.length === 0) {
    const hint = el("div", "py-[26px] px-3 text-center text-muted", `当前「${ctx.group} 方案」还没有选片 — 在上方网格里点选场次即可加入。`);
    const otherCount = ctx.slots.size - codesOfGroup.length;
    if (otherCount > 0) {
      hint.textContent = `当前「${ctx.group} 方案」未选片,「${ctx.group === "A" ? "B" : "A"} 方案」已有 ${otherCount} 场。`;
    }
    wrap.appendChild(hint);
    return wrap;
  }

  // 按日期分组,日期内按开始时间排序
  const days = new Map<string, Screening[]>();
  for (const code of codesOfGroup) {
    const s = ctx.cat.byCode.get(code);
    if (!s) continue;
    const arr = days.get(s.date) ?? [];
    arr.push(s);
    days.set(s.date, arr);
  }
  const dates = [...days.keys()].sort();

  for (const date of dates) {
    const list = days.get(date)!;
    list.sort((a, b) => a.start_time.localeCompare(b.start_time));
    const { label, weekday } = dateInfo(date);

    const section = el("section", "grid gap-[6px]");
    const head = el("div", "flex items-center gap-[10px]");
    const title = el(
      "button",
      "border-0 bg-transparent p-0 text-[14px] font-bold text-ink hover:text-biff",
      `${label} ${weekday} · ${list.length} 场`
    );
    title.dataset.jump = date;
    title.title = "在网格中查看这一天";
    const conf = ctx.conflicts.get(date);
    const headBadge = el(
      "span",
      "text-[12px] text-conf font-semibold",
      conf && conf.pairs.length ? `⚠ ${conf.pairs.length} 处重叠` : ""
    );
    head.append(title, headBadge);
    section.appendChild(head);

    let prev: Screening | null = null;
    for (const s of list) {
      const slot = ctx.slots.get(s.code)!;
      section.appendChild(buildRow(ctx, s, slot.group, ctx.picks.get(slot.key), prev, conf));
      prev = s;
    }
    wrap.appendChild(section);
  }
  return wrap;
}

function buildRow(
  ctx: AgendaCtx,
  s: Screening,
  group: Group,
  rec: PickEntry | undefined,
  prev: Screening | null,
  conf: ConflictResult | undefined
): HTMLElement {
  const entryConf = conf && conf.codeSet.has(s.code);
  // 档位 = 影片级(唯一一份);同片多场必然同档 —— 改一处全片同步
  const priority = rec?.priority ?? null;
  const slotCount = rec?.picks.length ?? 1;

  // GV 映后谈:放弃(或 talk=0 不拆)时本行有效区间 = 正片末;参加 = 槽位末。开关在操作列。
  const talk = gvTalkMin(s);
  const talkOn = talk > 0 ? ctx.gvTalkOf(s.code) : true;
  const endHms = fmtEndClock(effEndMin(s, talkOn)); // 跨午夜 → "次日 05:35"

  // 基底 + 冲突态一次算完(JS 后续不需 toggle)
  const rowCls = entryConf
    ? "grid grid-cols-[118px_minmax(0,1fr)_auto] gap-[10px] items-center border border-conf rounded-[8px] px-[10px] py-2 bg-biff-tint shadow-[var(--shadow-card)] transition-[border-color,box-shadow] duration-[120ms] ease-in-out hover:border-line-strong hover:shadow-[var(--shadow-hover)] max-[720px]:grid-cols-[110px_minmax(0,1fr)]"
    : "grid grid-cols-[118px_minmax(0,1fr)_auto] gap-[10px] items-center border border-line rounded-[8px] px-[10px] py-2 bg-card shadow-[var(--shadow-card)] transition-[border-color,box-shadow] duration-[120ms] ease-in-out hover:border-line-strong hover:shadow-[var(--shadow-hover)] max-[720px]:grid-cols-[110px_minmax(0,1fr)]";
  const row = el("div", rowCls);
  row.dataset.code = s.code;

  // C1:网格「整点时段」筛选同步 —— 当日该时段内的已选行 slot-hit 高亮、时段外行 hour-dim 淡化
  // (时段命中判断与网格 hour-dim 同口径:区间重叠即命中;仅作用于筛选所在日期,其它日期不受影响)
  if (ctx.slotDate === s.date && ctx.slotHour != null) {
    const st = hmsToMin(s.start_time);
    const en = hmsToMin(s.end_time);
    const inSlot = st < (ctx.slotHour + 1) * 60 && en > ctx.slotHour * 60;
    row.classList.add(inSlot ? "slot-hit" : "hour-dim");
    if (inSlot)
      row.title = `位于所选 ${fmtEndClock(ctx.slotHour * 60)}–${fmtEndClock((ctx.slotHour + 1) * 60)} 时段(时间筛选联动)`;
  }

  const mapped = ctx.mappings.get(s.code);
  const zh = s.title_zh || mapped?.title_cn || s.title_en;

  // 时间列(<b>继承 13px 加粗;.a-dur span 另设)。有效区间随映后谈取舍变化;GV 行时长旁注明
  const durLine =
    talk > 0
      ? talkOn
        ? `${s.duration_min}min · 含映后 ${talk}′`
        : `${s.duration_min}min · 仅正片(已弃映后)`
      : `${s.duration_min}min`;
  const timeCol = el("div", "flex flex-col text-[13px] tabular-nums");
  timeCol.innerHTML = `<b>${escapeHtml(s.start_time)}–${escapeHtml(endHms)}</b><span class="block text-[11px] text-muted">${durLine}</span>`;
  if (prev && !entryConf) {
    timeCol.appendChild(gapNote(prev, s, ctx));
  }
  row.appendChild(timeCol);

  // 主信息列
  const mainCol = el("div", "min-w-0");
  const ttlLine = el("div", "flex items-center gap-[6px] flex-wrap");
  ttlLine.innerHTML = `<b class="text-biff text-[12.5px]">${escapeHtml(s.code)}</b> <span class="font-semibold">${escapeHtml(zh)}</span>`;
  ttlLine.querySelector("b")!.dataset.tip = codeTip(s.code); // 缩写说明:CODE 数字 hover 提示
  appendMetaRow(ttlLine, s); // 16-F:GV + 特性 + 等级/字幕/页码 徽章(hover 即示义)
  if (entryConf) {
    const others = conf!.pairs
      .filter(([a, b]) => a === s.code || b === s.code)
      .map(([a, b]) => (a === s.code ? b : a));
    const names = others.map((c) => `${c} ${titleOf(ctx, c)}`).join("、");
    ttlLine.appendChild(el("span", "text-conf text-[12px] font-semibold", ` ⚠ 与 ${names} 重叠`));
  }
  const subLine = el(
    "div",
    "text-[11.5px] text-muted mt-px",
    `${s.venue_display}${mapped?.douban_url ? " · 已关联豆瓣" : ""}`
  );
  mainCol.append(ttlLine, subLine);
  row.appendChild(mainCol);

  // 操作列
  const acts = el("div", "flex gap-[6px] items-center max-[720px]:col-span-full max-[720px]:justify-end");
  // GV 行两枚胶囊:① ⏱ 时长(覆写本场映后时长;**is_gv 恒显示**,即使当前 0 —— 否则全局默认设成 0
  //   后该场再也回不到「有谈段」);② 参加 / 放弃开关(仅在有谈段时有意义)。两者正交。
  if (s.is_gv) {
    const ov = gvTalkMinOv.get(s.code);
    const talkMinBtn = el(
      "button",
      `rounded-full border px-[9px] py-[3px] text-[12px] font-semibold whitespace-nowrap transition-colors hover:border-biff hover:text-biff ${
        ov == null ? "border-line bg-card text-muted" : "border-biff-line bg-biff-soft text-biff"
      }`,
      `⏱ ${talk}′`
    );
    talkMinBtn.dataset.act = "gv-talk-min";
    talkMinBtn.title =
      ov == null
        ? `本场映后谈 ${talk} 分钟(跟随全局默认)。点击可单独设本场时长`
        : `本场映后谈 ${talk} 分钟(已单独设置,不跟随全局默认 ${store.settings.gvTalkMin}′)。点击可改 / 清除`;
    acts.append(talkMinBtn);
  }
  // 映后谈开关胶囊:✓含映后 / ✕弃映后;翻转仅覆写本场(不动全局默认)
  let talkBtn: HTMLElement | null = null;
  if (talk > 0) {
    const offCls = "border border-line bg-card text-muted line-through";
    const onCls = "border border-ok text-ok bg-[color-mix(in_srgb,var(--color-ok)_9%,var(--color-card))]";
    talkBtn = el(
      "button",
      `rounded-full px-[9px] py-[3px] text-[12px] font-semibold whitespace-nowrap transition-colors hover:border-biff hover:text-biff ${talkOn ? onCls : offCls}`,
      talkOn ? "✓ 含映后" : "✕ 弃映后"
    );
    talkBtn.dataset.act = "gv-talk";
    const talkEnd = fmtEndClock(filmEndMin(s) + talk); // 谈段末 = 正片末 + 配置时长
    talkBtn.title = talkOn
      ? `当前连映后谈一起参加(到 ${talkEnd} 结束)。点击放弃 → 只看正片,本场按 ${fmtEndClock(filmEndMin(s))} 结束,与后场的转场/冲突即时按正片末放宽`
      : `已放弃映后谈(正片至 ${fmtEndClock(filmEndMin(s))} 结束)。点击恢复 → 连映后谈一起参加,按 ${talkEnd} 结束`;
  }
  const grpBtn = el(
    "button",
    "border bg-card rounded-full px-[10px] py-[3px] text-[12px] font-semibold hover:border-biff border-[color-mix(in_srgb,var(--color-biff)_40%,var(--color-card))] text-biff",
    group
  );
  grpBtn.dataset.act = "grp";
  grpBtn.title = "切换到另一方案(点击翻转;只动本场归属,不改影片档位)";
  // §14 2c:优先级三段 seg(必看/备选/随缘),当前态实心着色;点击直接定位
  // 档位只有一份且在影片级(与「我的选片」同源,见 pick.ts)→ 点这里 = 改该片档位,同片所有场次同步
  // priority=null(「未设」)已下线:加入场次时强制定档、清空档位即整片移出,载入还会清掉存量脏记录。
  // 下面的兜底分支保留作防御 —— 真出现 null 时左侧明示「未设」,好过三段全灰被误读成「默认备选」。
  if (priority == null) {
    acts.appendChild(el("span", "text-[11px] text-muted font-semibold whitespace-nowrap", "未设"));
  }
  const syncHint = slotCount > 1 ? ` · 本片共 ${slotCount} 场,档位为影片级,改一处全片同步` : "";
  const priSeg = el("div", "inline-flex border border-line rounded-full overflow-hidden bg-card");
  priSeg.title =
    priority == null
      ? `未设档位 · 点选设置 · 未设不参与质量分与抢票顺位${syncHint}`
      : `档位为影片级(「我的选片」同一份数据)${syncHint}`;
  WISH_ORDER.forEach(([p, label], i) => {
    const on = priority === p;
    const stateCls = on
      ? PRI_BG_ON[p]
      : "bg-card text-muted hover:text-ink";
    const sepCls = i > 0 ? " border-l border-line" : "";
    const b = el(
      "button",
      `border-0 px-[9px] py-[3px] text-[12px] font-semibold transition-[background,color] duration-[120ms] ease-in-out ${stateCls}${sepCls}`,
      label
    );
    b.dataset.act = "pri";
    b.dataset.pri = p;
    // 再点当前档 = 取消 → 回到「未设」(与「我的选片」打标 seg 同语义)
    // 再点当前档 = 取消 → 该片退出选片(整条删除,已排场次一并移出)。「未设」不再是合法状态
    // (档位是入选片单的必要条件,与加入场次时的强制定档互为兜底),故不再回到「未设」。
    b.title = on
      ? `取消「${label}」→ 该片退出选片(已排 ${slotCount} 场一并移出)${syncHint}`
      : `设为「${label}」${p === "must" ? "(冲突高优先级,导出顺位靠前)" : ""}${syncHint}`;
    priSeg.appendChild(b);
  });
  const delBtn = el(
    "button",
    "border border-line bg-card rounded-full px-[10px] py-[3px] text-[12px] font-semibold hover:border-biff text-muted",
    "✕"
  );
  delBtn.dataset.act = "del";
  delBtn.title = slotCount > 1
    ? `移出该场(只删这一场;该片仍在「我的选片」,另外 ${slotCount - 1} 场不受影响)`
    : "移出该场(该片仍留在「我的选片」,标注「未排场」)";
  if (talkBtn) acts.append(talkBtn);
  acts.append(grpBtn, priSeg, delBtn);
  row.appendChild(acts);

  return row;
}

/** 16-D 相邻场次转场间隔三态:余量 = 间隔 − 跨馆缓冲(跨馆时)。
 *  ok=余量≥OK_SLACK / tight=0≤余量<OK_SLACK / bad=扣除缓冲后为负(赶不上,红色警告)。
 *  重叠冲突由 conf 行态展示,不在此重复标红。 */

function gapNote(prev: Screening, s: Screening, ctx: AgendaCtx): HTMLElement {
  // 上一场按「有效结束」算(放弃映后谈 → 正片末,间隔随之放宽)
  const prevTalkOn = gvTalkMin(prev) > 0 ? ctx.gvTalkOf(prev.code) : true;
  const prevEnd = fmtEndClock(effEndMin(prev, prevTalkOn));
  const gap = hmsToMin(s.start_time) - effEndMin(prev, prevTalkOn);
  const cross = prev.venue_id !== s.venue_id;
  const need = cross ? ctx.transitMin : 0;
  const slack = gap - need;
  const prevOff = prevTalkOn ? "" : " · 上场弃映后";
  const baseCls = "block text-[10.5px] text-muted mt-[2px]";
  let state = "ok";
  let txt = `↖ 距上一场 ${gap}min${cross ? " · 跨馆" : ""}${prevOff}`;
  let stateCls = "";
  if (slack < 0) {
    state = "bad";
    stateCls = " text-conf font-extrabold";
    txt += ` · 需缓冲 ${need}min`;
  } else if (slack < OK_SLACK) {
    state = "tight";
    stateCls = " text-tight font-bold";
  }
  const g = el("span", `${baseCls}${stateCls}`, txt);
  g.title = cross
    ? `跨馆转场:上一场 ${prev.code} 至 ${prevEnd}结束 · 间隔 ${gap}min − 缓冲 ${need}min = 余量 ${slack}min(${state === "bad" ? "不足" : state === "tight" ? "偏紧" : "宽裕"})`
    : `同馆相邻:上一场 ${prev.code} 至 ${prevEnd}结束 · 间隔 ${gap}min(余量 ${gap}min)`;
  return g;
}

function titleOf(ctx: AgendaCtx, code: string): string {
  const s = ctx.cat.byCode.get(code);
  if (!s) return "";
  const zh = s.title_zh || ctx.mappings.get(code)?.title_cn || s.title_en;
  return zh.length > 10 ? zh.slice(0, 10) + "…" : zh;
}