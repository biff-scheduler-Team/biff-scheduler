// 我的行程 — 按日期分组的议程列表:冲突标红、优先级/方案可直接切换。
// 与「我的选片」同一份数据(store.picks):本视图按场次展开,行内 ★ 改的是**该片档位**(影片级)。
// 全量化:行程行 / 卡片 / 转场连接件 / 冲突提示 全部 Tailwind utility。
//
// 排版(2026-09-11 三改:骨架全部收口在 `row.ts::cardHead` / `screeningRow`,与「影片库 /
// 我的选片」影片卡**同一套设计语言** —— 同一阅读顺序「片名在上、场次在下」,同一卡片头三列栅格):
//   ┌──────────────────────────────────────────────────────────────┐
//   │  No Other Choice                       [映后 20′][A][★][✕]    │ ← 卡片头(cardHead)
//   │  The Chronology of Water · cons · France · 2025 · ASSAYAS     │ ← 影片信息行
//   │ [001][BT] 9/17 周三 18:00–20:39                              │ ← 场次行第 1 层:身份 + 操作
//   │ [139min][15][KE][P.43]                                       │ ← 场次行第 2 层:章组
//   │ ⚠ 与 042 重叠(仅冲突行)                                       │
//   └──────────────────────────────────────────────────────────────┘
//          ┊ 赶场间隔 119min · 跨馆缓冲 15min ┊                     ← 卡片**之间**:虚线竖轨连接件
// 卡片头的第 1 列(折叠箭头)在行程卡上是**空占位** —— 故片名左缘与影片卡严格对齐。
// 行程特有内容只收两处:① 卡片头右缘的操作组(映后胶囊 / A / ★ / ✕);② 追加行(冲突提示)。
// 日期不重复(已按日分组,传 `hideDate: true`);转场间隔在卡片之间的虚线连接件上(卡片内不再出现)。
// (曾按 `PLAN-20260910194000` 做过「片名置顶 + 元信息灰文本」的**行程档**,元信息部分已撤销;
//  片名置顶保留 —— 但改为**卡片头**形态(与选片卡「片名行」同款),而非行内主视觉。)

import type { Catalog, Group, Mapping, PickEntry, Screening } from "./types";
import { dateInfo, displayTitle, el, filmInfoOf, filmInfoText, fmtEndClock, hmsToMin, slackBetween } from "./util";
import { effEndMin, filmEndMin, gvTalkMin } from "./gv";
import { gvTalkMinOv, setPriorityOfCode, store } from "./state";
import { CARD_SHELL_CLS, CARD_SHELL_CONF_CLS, screeningRow } from "./row";
import { wishIcon } from "./pick";
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

  for (const [di, date] of dates.entries()) {
    const list = days.get(date)!;
    list.sort((a, b) => a.start_time.localeCompare(b.start_time));
    const { label, weekday } = dateInfo(date);

    // ---- 日期分隔(2026-09-10 加):每天一块 = **上分割线 + 加粗大日期** ——
    //  旧版日期头与卡片同字阶(14px)、无分割线,滚动时「哪几场是同一天」糊成一片。
    //  ⚠ 首日不出线(上方没有要隔开的内容);`border-line-strong`(#c9c9c9)比卡片边框
    //    `--line`(#e0e0e0)深一档 —— 压得住卡片,又不像墨黑那样抢主视觉。
    const section = el(
      "section",
      "grid gap-[8px]" + (di > 0 ? " pt-[12px] border-t border-line-strong" : "")
    );
    // 日期 + 场数同一枚 button(整块可点 = 切网格到这一天),但**两段字阶**:
    // 日期 16px 加粗(主视觉),场数 12.5px 次级灰 —— 否则「2 场」跟着放大,与日期抢戏。
    const head = el("div", "flex items-center gap-[10px] flex-wrap");
    const title = el(
      "button",
      "group border-0 bg-transparent p-0 flex items-baseline gap-[8px] leading-tight"
    );
    title.dataset.jump = date;
    title.dataset.tip = "在网格中查看这一天(切到该日期 + 当天场次批量闪烁)";
    title.appendChild(el("span", "text-16 font-bold text-ink group-hover:text-biff-ink", `${label} ${weekday}`));
    title.appendChild(el("span", "text-13 font-semibold text-muted", `${list.length} 场`));
    const conf = ctx.conflicts.get(date);
    const headBadge = el(
      "span",
      "text-13 text-conf font-semibold",
      conf && conf.pairs.length ? `⚠ ${conf.pairs.length} 处重叠` : ""
    );
    head.append(title, headBadge);
    section.appendChild(head);

    let prev: Screening | null = null;
    for (const s of list) {
      const slot = ctx.slots.get(s.code)!;
      // 赶场间隔**提级到卡片之间**(原在卡片内右下角,极易被漏掉)—— 见 gapConnector。
      // 当前行自身冲突时不出连接件:冲突提示已占一行,再叠一条转场提示只会更吵(旧口径一致)。
      if (prev && !conf?.codeSet.has(s.code)) section.appendChild(gapConnector(ctx, prev, s));
      section.appendChild(buildRow(ctx, s, slot.group, ctx.picks.get(slot.key), conf));
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
  conf: ConflictResult | undefined
): HTMLElement {
  const entryConf = Boolean(conf?.codeSet.has(s.code));
  // 档位 = 影片级(唯一一份);同片多场必然同档 —— 改一处全片同步
  const priority = rec?.priority ?? null;
  const slotCount = rec?.picks.length ?? 1;

  // GV 映后谈:放弃(或 talk=0 不拆)时本行有效区间 = 正片末;参加 = 槽位末。开关在「映后」胶囊上。
  const talk = gvTalkMin(s);
  const talkOn = talk > 0 ? ctx.gvTalkOf(s.code) : true;
  const endHms = fmtEndClock(effEndMin(s, talkOn)); // 跨午夜 → "次日 05:35"

  // ---- 统一骨架 + 卡片头(片名 + 影片信息行,见 row.ts::screeningRow)----
  //  阅读顺序与「我的选片」影片卡完全一致:**片名在上、场次在下** ——
  //  行 1 = 片名(15px 加粗,选片卡头同款) + 行程特有操作(映后 / A / ★ / ✕)贴右;
  //  行 2 = 影片信息(「原始片名 · 单元 · 国家 · 年份 · 导演」,选片卡副标题同款);
  //  行 3 = [CODE][影院][时间] [片长·等级·字幕·GV·页码](三处同一套描边章)
  //  行 4 = 冲突提示(仅冲突行)
  //  ⚠ 片名 / 信息行**与选片卡同源**(`util.ts::filmInfoOf`)—— 原先行程卡只有片名一行,
  //    2026-09-10 按用户要求补上信息行(「其实你对标我的选片就行」),故不再自拼片名。
  //  ⚠ 时间用「有效结束」(含映后 / 弃映后即时放宽),与网格口径一致;选片行用官方槽位时间。
  const info = filmInfoOf(ctx.cat, s, ctx.mappings.get(s.code));
  const row = screeningRow({
    s,
    cat: ctx.cat,
    // 卡片外壳(行程卡 = 卡片头 + 场次行,骨架与「影片库 / 我的选片」影片卡同一套 —— 见 row.ts)
    cardCls: entryConf ? CARD_SHELL_CONF_CLS : CARD_SHELL_CLS,
    headTitle: info.zh,
    headSub: filmInfoText(info),
    hideDate: true,
    timeText: `${s.start_time}–${endHms}`,
    acts: buildActs(ctx, s, group, priority, slotCount, talk),
    extra: buildConf(ctx, s, entryConf, conf),
  });

  // C1:网格「整点时段」筛选同步 —— 当日该时段内的已选行 slot-hit 高亮、时段外行 hour-dim 淡化
  if (ctx.slotDate === s.date && ctx.slotHour != null) {
    const st = hmsToMin(s.start_time);
    const en = hmsToMin(s.end_time);
    const inSlot = st < (ctx.slotHour + 1) * 60 && en > ctx.slotHour * 60;
    row.classList.add(inSlot ? "slot-hit" : "hour-dim");
    if (inSlot)
      row.dataset.tip = `位于所选 ${fmtEndClock(ctx.slotHour * 60)}–${fmtEndClock((ctx.slotHour + 1) * 60)} 时段(时间筛选联动)`;
  }

  return row;
}

/** 行程卡的**卡片头右缘操作组**(`acts`):①「映后 N′」合并胶囊(点标签 = 含/弃,点数字 = 改本场时长);
 *  ② A/B 方案标;③ ★ 档位星标;④ ✕ 移出(极淡,卡 hover 才完全显现)。
 *  ⚠ 四枚都是**行程特有**的操作 —— 位置对齐选片卡「片名行右上角图标组」,`ml-auto` 贴右。 */
function buildActs(
  ctx: AgendaCtx,
  s: Screening,
  group: Group,
  priority: "must" | "maybe" | "wild" | null,
  slotCount: number,
  talk: number
): HTMLElement {
  const acts = el("div", "flex items-center gap-[6px] shrink-0");

  // ---- ① 映后:一枚胶囊同时表达「含/弃」与「本场时长」(旧版是 ⏱ N′ + ✓含映后 两枚正交胶囊) ----
  //  含 = 浅绿底绿字(与网格「已选 / 谈段」同一套 ok 色);弃 = 中性灰 + 删除线。
  //  ⚠ 时长覆写入口收在**数字**上(span 而非嵌套 button,HTML 合法):点击目标经
  //    `closest("[data-act]")` 命中最内层 → main.ts 走 `gv-talk-min` 小弹层;点标签其余部分 = 含/弃。
  if (talk > 0) {
    const talkOn = ctx.gvTalkOf(s.code);
    const ov = gvTalkMinOv.get(s.code);
    const onCls = "border border-ok text-ok bg-[color-mix(in_srgb,var(--color-ok)_9%,var(--color-card))]";
    const offCls = "border border-line bg-card text-muted line-through";
    const tag = el(
      "button",
      `rounded-full px-[8px] py-[1px] text-11 font-semibold whitespace-nowrap transition-colors hover:border-biff ${talkOn ? onCls : offCls}`
    );
    tag.dataset.act = "gv-talk";
    tag.appendChild(document.createTextNode(talkOn ? "映后 " : "弃映后 "));
    const num = el("span", talkOn ? "underline decoration-dotted underline-offset-2" : "", `${talk}′`);
    num.dataset.act = "gv-talk-min";
    num.dataset.tip =
      ov == null
        ? `本场映后谈 ${talk} 分钟(跟随全局默认 ${store.settings.gvTalkMin}′)。点数字可单独设本场时长`
        : `本场映后谈 ${talk} 分钟(已单独设置,不跟随全局默认 ${store.settings.gvTalkMin}′)。点数字可改 / 清除`;
    tag.appendChild(num);
    const talkEnd = fmtEndClock(filmEndMin(s) + talk); // 谈段末 = 正片末 + 配置时长
    tag.dataset.tip = talkOn
      ? `连映后谈一起参加(到 ${talkEnd} 结束)。点标签 = 放弃 → 只看正片,本场按 ${fmtEndClock(filmEndMin(s))} 结束,转场 / 冲突即时放宽`
      : `已放弃映后谈(正片至 ${fmtEndClock(filmEndMin(s))} 结束)。点标签 = 恢复参加,按 ${talkEnd} 结束`;
    acts.appendChild(tag);
  }

  // ---- ② A/B 方案标(点即翻转;只动本场归属,不改影片档位) ----
  const grpBtn = el(
    "button",
    "border-0 bg-transparent p-0 w-[18px] h-[18px] inline-flex items-center justify-center rounded-4 " +
      "text-11 font-extrabold leading-none text-biff-ink transition-colors duration-[120ms] hover:bg-[var(--bg-hover-soft)]",
    group
  );
  grpBtn.dataset.act = "grp";
  grpBtn.dataset.tip = "当前方案 — 点击切到另一方案(只动本场归属,不改影片档位)";
  acts.appendChild(grpBtn);

  // ---- ③ ★ 档位(影片级;同片多场同步) ----
  const syncHint = slotCount > 1 ? ` · 本片共 ${slotCount} 场,档位为影片级,改一处全片同步` : "";
  const star = wishIcon({
    cur: priority,
    anchor: s.code,
    onPick: (p) => setPriorityOfCode(s.code, p),
    tipPrefix: "我的行程 · ",
  });
  star.dataset.tip =
    priority == null
      ? `未设档位 · 点选设置 · 未设不参与质量分与抢票顺位${syncHint}`
      : `档位为影片级(「我的选片」同一份数据)${syncHint}`;
  acts.appendChild(star);

  // ---- ④ ✕ 移出:极淡(hover 才完全显现),避免误触 ----
  const delBtn = el(
    "button",
    "border-0 bg-transparent p-0 w-[18px] h-[18px] inline-flex items-center justify-center rounded-4 " +
      "text-12 leading-none text-faint opacity-40 transition-[opacity,color,background-color] duration-[120ms] " +
      "hover:text-conf hover:bg-[var(--bg-hover-soft)] group-hover:opacity-100",
    "✕"
  );
  delBtn.dataset.act = "del";
  delBtn.dataset.tip = "移出该场(该片仍留在「我的选片」,标注「未排场」)";
  acts.appendChild(delBtn);
  return acts;
}

/** 行程行的**追加行**(仅冲突行有,`extra`):冲突对方 CODE + 片名。
 *  片名本体已提到卡片头(`headTitle`),本行只剩冲突;
 *  转场间隔不在卡内(提级到卡片之间的连接件,见 gapConnector)。 */
function buildConf(
  ctx: AgendaCtx,
  s: Screening,
  entryConf: boolean,
  conf: ConflictResult | undefined
): HTMLElement | null {
  if (!entryConf || !conf) return null;
  const others = conf.pairs
    .filter(([a, b]) => a === s.code || b === s.code)
    .map(([a, b]) => (a === s.code ? b : a));
  const names = others.map((c) => `${c} ${titleOf(ctx, c)}`).join("、");
  return el("div", "flex items-center gap-[6px] text-11 text-conf font-semibold", `⚠ 与 ${names} 重叠`);
}

/** 相邻两场之间的**赶场间隔**连接件(2026-09-10 提级:原在卡片内右下角,极易被漏掉)。
 *  浅灰虚线竖轨 + 间隔文案 → 竖着读就是一条时间轴,「下一场赶不赶得上」不再需要逐卡去找。
 *  三态沿用旧口径:余量 = 间隔 − 跨馆缓冲;bad(余量 < 0)红 / tight(< OK_SLACK)黄 / ok 灰。 */
function gapConnector(ctx: AgendaCtx, prev: Screening, s: Screening): HTMLElement {
  // 上一场按「有效结束」算(放弃映后谈 → 正片末,间隔随之放宽);判定口径与网格黄卡同源
  const prevTalkOn = gvTalkMin(prev) > 0 ? ctx.gvTalkOf(prev.code) : true;
  const prevEnd = fmtEndClock(effEndMin(prev, prevTalkOn));
  const cross = prev.venue_id !== s.venue_id;
  const { gap, need, slack, verdict: v } = slackBetween(
    effEndMin(prev, prevTalkOn),
    hmsToMin(s.start_time),
    !cross,
    ctx.transitMin
  );

  const wrap = el("div", "relative flex items-center min-h-[18px] pl-[16px] py-[1px]");
  wrap.appendChild(el("span", "absolute left-[7px] top-0 bottom-0 border-l border-dashed border-line-strong"));

  let txt = `赶场间隔 ${gap}min`;
  // 跨馆且缓冲非 0 才印(默认 transitMin = 0 时「跨馆缓冲 0min」是噪声)
  if (cross && need > 0) txt += ` · 跨馆缓冲 ${need}min`;
  if (!prevTalkOn) txt += " · 上场弃映后";
  let stateCls = "text-muted";
  let verdict = "宽裕";
  if (v === "bad") {
    stateCls = "text-conf font-extrabold";
    verdict = "不足";
    txt += " ⚠ 赶不上";
  } else if (v === "tight") {
    stateCls = "text-tight font-bold";
    verdict = "偏紧";
  }
  const label = el("span", `text-11 ${stateCls}`, txt);
  label.dataset.tip = cross
    ? `跨馆转场:上一场 ${prev.code} 至 ${prevEnd} 结束 · 间隔 ${gap}min − 缓冲 ${need}min = 余量 ${slack}min(${verdict})`
    : `同馆相邻:上一场 ${prev.code} 至 ${prevEnd} 结束 · 间隔 ${gap}min(余量 ${gap}min)`;
  wrap.appendChild(label);
  return wrap;
}

function titleOf(ctx: AgendaCtx, code: string): string {
  const s = ctx.cat.byCode.get(code);
  if (!s) return "";
  const zh = displayTitle(s, ctx.mappings.get(code)?.title_cn);
  return zh.length > 10 ? zh.slice(0, 10) + "…" : zh;
}
