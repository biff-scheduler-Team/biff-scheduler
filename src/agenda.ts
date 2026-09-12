// 我的行程 — 按日期分组的议程列表:冲突组可拖动排序(抢票顺位)、N 套方案并列对比。
// 与「我的选片」同一份数据(store.picks):本视图按场次展开。
// 全量化:行程行 / 卡片 / 转场连接件 / 冲突提示 / 方案卡 全部 Tailwind utility。
//
// 排版(2026-09-11 三改:骨架全部收口在 `row.ts::cardHead` / `screeningRow`,与「影片库 /
// 我的选片」影片卡**同一套设计语言** —— 同一阅读顺序「片名在上、场次在下」,同一卡片头三列栅格):
//   ┌──────────────────────────────────────────────────────────────┐
//   │  No Other Choice                       [映后 20′][顺位 1][✕]  │ ← 卡片头(cardHead;拖拽把手在第 1 列)
//   │  The Chronology of Water · cons · France · 2025 · ASSAYAS     │ ← 影片信息行
//   │ [001][BT] OCT 8 周三 18:00–20:39                             │ ← 场次行第 1 层:身份 + 操作
//   │ [139min][15][KE][P.43]                                       │ ← 场次行第 2 层:章组
//   └──────────────────────────────────────────────────────────────┘
//          ┊ 赶场间隔 119min · 跨馆缓冲 15min ┊                     ← 卡片**之间**:虚线竖轨连接件
//
// ★ 顺位 / 方案(2026-09-11 起;**2026-09-12 改为「用户保存方案」**):
//   同一时间带互相重叠的几场折叠成一张**顺位卡**,组内按**偏好次序**排列,拖动左侧 ⠿ 即可改序。
//   **顺位只表达「多想保哪场」,不决定分组**;**方案 = 用户手动存下来的快照**(`state.ts::savedPlans`)——
//   「保存当前方案」把**第一顺位方案**(每个冲突组取顺位 1 的那场 + 共同场次)存下来,
//   导出 / 分享时按方案导出(见 `export-panel.ts`)。
//   ⚠ 旧的「枚举全部组合并列对比」区已于 2026-09-12 **整体下线** —— 方案不是算出来的,是用户存出来的。
//   **同一部片在一个方案里只出现一次**(2026-09-11 三改,`PLAN-20260911230500`):行程里留着
//   「同一部片的两天场次」是抢票备选,不该让「第一顺位方案」变成同一部片看两遍(见 `plans.ts` 文件头)。
//   **顺位撞车**(2026-09-12):两个冲突组在**同一层**(各组第 k 场)撞到同一部片时,那一层的组合会被
//   上一条剔除 ⇒ 行程顶部出**黄框提示 + 逐条让路 + 一键全部修复(带预览)**,见 `buildRankClashNote`。
//   **顺位卡走绿框 OK**(不是红框警报):顺位接手之后重叠已不是错误状态,见 `buildConflictGroup` 文件头。
//
// ⚠ 档位(必看 / 备选 / 随缘)已于 2026-09-11 整体删除 —— 它在冲突场景里的作用被「拖动顺位」
//   完全取代,在非冲突场景里只剩排序噪声(两套排序机制并存只会互相打架)。
// 日期不重复(已按日分组,传 `hideDate: true`);转场间隔在卡片之间的虚线连接件上(卡片内不再出现)。

import type { Catalog, Mapping, Screening } from "./types";
import { dateInfo, displayTitle, el, filmInfoOf, filmInfoText, fmtEndClock, hmsToMin, slackBetween } from "./util";
import { formatKrw, priceOf } from "./extras";
import { effEndMin, filmEndMin, gvTalkMin } from "./gv";
import {
  deletePlan,
  gvTalkMinOv,
  isAgendaFolded,
  savePlan,
  savedPlans,
  setRanks,
  store,
  toggleAgendaFold,
  type SavedPlan,
} from "./state";
import { CARD_SHELL_CLS, screeningRow } from "./row";
import { BTN_GO_SM } from "./ui";
import { toast } from "./toast";
import type { ConflictResult } from "./conflict";
import { autoFixRanks, type PlanSet, type RankClash, type RankFixPlan } from "./plans";

export interface AgendaCtx {
  cat: Catalog;
  /** 已选场次投影:code → 影片 key(唯一数据源的场次视图) */
  slots: Map<string, { key: string }>;
  mappings: Map<string, Mapping>;
  transitMin: number;
  /** GV 映后谈是否参加(全局默认 + 单场覆写解析后):决定本行有效区间 / 开关态 / 与上一场间隔 */
  gvTalkOf: (code: string) => boolean;
  conflicts: Map<string, ConflictResult>; // 全日期冲突(与网格同源)
  /** 顺位 → N 套方案(见 `plans.ts`)。由 main 侧统一派生 —— 行程只读,不自己算一遍。 */
  plans: PlanSet;
  /** 场次 → 影片 key(与网格 / 影片库同口径)—— 顺位撞车检测 / 一键修复用 */
  filmKeyOf: (code: string) => string | null;
  /** C1:网格时间筛选(整点时段)联动 —— 当日同段行 slot-hit 高亮,当日不同段行 hour-dim 淡化 */
  slotDate?: string;
  slotHour?: number | null;
}

export function buildAgenda(ctx: AgendaCtx): HTMLElement {
  const wrap = el("div", "grid gap-[14px]");
  const codes = [...ctx.slots.keys()];

  if (codes.length === 0) {
    wrap.appendChild(
      el("div", "py-[26px] px-3 text-center text-muted", "还没有选片 — 在上方网格里点选场次即可加入。")
    );
    return wrap;
  }

  // ---- 顺位撞车提示(2026-09-12):两个冲突组在**同一层**上撞到同一部片 ----
  //  排在「已保存方案」**之前** —— 它解释的正是「为什么第一顺位方案可能存不下来」。
  const clashNote = buildRankClashNote(ctx);
  if (clashNote) wrap.appendChild(clashNote);

  // ---- 已保存方案(替换原「枚举对比」区;2026-09-12)----
  wrap.appendChild(buildSavedPlans(ctx));

  // 「方案内部仍重叠」的场次(理论恒空;非空 = 冲突口径有洞)—— **只有它才配红色警报**。
  // 顺位接手之后,「两场重叠」本身不再是错误状态:它展开成 N 套各自可行的方案,
  // 故冲突组默认走**绿框 OK**(见 buildConflictGroup 文件头)。
  const brokenCodes = ctx.plans.broken;

  // 按日期分组,日期内按开始时间排序
  const days = new Map<string, Screening[]>();
  for (const code of codes) {
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
    // 日期头的冲突摘要:实心红点 + 「N 处时间重叠」(取代旧 ⚠ 字形 —— 用户不要 emoji)
    const conf = ctx.conflicts.get(date);
    const headBadge = el("span", "inline-flex items-center gap-[5px] text-13 text-conf font-semibold");
    if (conf && conf.pairs.length) {
      headBadge.appendChild(el("i", "inline-block w-[8px] h-[8px] rounded-full bg-conf"));
      headBadge.appendChild(el("span", "", `${conf.pairs.length} 处时间重叠`));
    }
    // 当日票价小计 —— 票价口径见 `extras.ts::priceOf`(开闭幕 / 午夜 / 大师班 / 普通各不同)
    const dayKrw = list.reduce((n, x) => n + priceOf(x), 0);
    head.append(title, headBadge, el("span", "text-12 text-muted tabular-nums", `当日 ${formatKrw(dayKrw)}`));

    // ---- 按日收起(2026-09-11):日期头左缘的折叠箭头,每块独立开合 ----
    //  ⚠ 与日期标题**分成两枚按钮**:标题点击 = 切网格到这一天(整块可点),
    //    箭头点击 = 只折叠本块视图 —— 两者语义完全不同,合并会让「想展开却跳走」。
    //  ⚠ 折叠是**纯视图偏好**(state.ts::agendaFolded 落 localStorage):只藏卡片与转场连接件,
    //    不动选片 / 排片数据;收起时补一行时间跨度摘要,「这天从几点到几点」不必展开也能看到。
    const folded = isAgendaFolded(date);
    const foldBtn = el(
      "button",
      "shrink-0 w-[24px] h-[24px] inline-flex items-center justify-center rounded-6 border " +
        "text-14 leading-none font-bold transition-colors duration-[120ms] " +
        (folded
          ? "border-biff bg-biff-tint text-biff-ink hover:bg-card"
          : "border-line bg-card text-ink-2 hover:border-biff hover:text-biff-ink hover:bg-biff-tint")
    );
    foldBtn.dataset.fold = date;
    foldBtn.textContent = folded ? "▸" : "▾";
    foldBtn.setAttribute("aria-expanded", folded ? "false" : "true");
    foldBtn.dataset.tip = folded
      ? `展开 ${label} 的 ${list.length} 场(仅折叠视图,不影响选片)`
      : `收起 ${label} 的 ${list.length} 场(仅折叠视图,不影响选片)`;
    foldBtn.addEventListener("click", () => toggleAgendaFold(date));
    head.prepend(foldBtn);
    section.appendChild(head);

    if (folded) {
      const last = list[list.length - 1];
      const lastTalkOn = gvTalkMin(last) > 0 ? ctx.gvTalkOf(last.code) : true;
      const span = el(
        "span",
        "text-12 text-muted tabular-nums",
        `${list[0].start_time.slice(0, 5)}–${fmtEndClock(effEndMin(last, lastTalkOn))}`
      );
      span.dataset.tip = "本日已收起 —— 点左侧箭头展开(收起只是视图折叠,选片 / 排片数据不受影响)";
      head.appendChild(span);
      wrap.appendChild(section);
      continue;
    }

    // ---- 冲突组「顺位卡」:同一时间带互相重叠的几场折叠成一张卡,组内可拖动排序 ----
    //  组来自 `plans.groups`(**已按顺位排好**)—— 行程不再自己排一遍,免得两处口径漂移。
    const groupOf = new Map<string, string[]>();
    for (const g of ctx.plans.groups) for (const c of g) groupOf.set(c, g);
    const renderedGroups = new Set<string>();

    let prev: Screening | null = null;
    for (const s of list) {
      const g = groupOf.get(s.code);
      if (g) {
        // 整组只在**最先遇到的那一场**的位置渲染一次(组内其余成员跳过)
        if (renderedGroups.has(g[0])) continue;
        renderedGroups.add(g[0]);
        section.appendChild(buildConflictGroup(ctx, g, brokenCodes));
        // 组后不接转场连接件:组内有多场,「上一场」不唯一,接谁都是错的
        prev = null;
        continue;
      }
      // 赶场间隔**提级到卡片之间**(原在卡片内右下角,极易被漏掉)—— 见 gapConnector。
      if (prev) section.appendChild(gapConnector(ctx, prev, s));
      section.appendChild(buildRow(ctx, s));
      prev = s;
    }
    wrap.appendChild(section);
  }
  return wrap;
}

function buildRow(
  ctx: AgendaCtx,
  s: Screening,
  opts: { inConflictGroup?: boolean; rank?: number } = {}
): HTMLElement {
  // GV 映后谈:放弃(或 talk=0 不拆)时本行有效区间 = 正片末;参加 = 槽位末。开关在「映后」标签上。
  const talk = gvTalkMin(s);
  const talkOn = talk > 0 ? ctx.gvTalkOf(s.code) : true;
  const endHms = fmtEndClock(effEndMin(s, talkOn)); // 跨午夜 → "次日 05:35"

  // ---- 统一骨架 + 卡片头(片名 + 影片信息行,见 row.ts::screeningRow)----
  //  阅读顺序与「我的选片」影片卡完全一致:**片名在上、场次在下** ——
  //  行 1 = 片名 + 行程特有操作(映后 / 顺位 / ✕)贴右;
  //  行 2 = 影片信息(「原始片名 · 单元 · 国家 · 年份 · 导演」,选片卡副标题同款);
  //  行 3 = [CODE][影院][时间] [片长·等级·字幕·GV·页码](三处同一套描边章)
  //  ⚠ 片名 / 信息行**与选片卡同源**(`util.ts::filmInfoOf`)—— 原先行程卡只有片名一行,
  //    2026-09-10 按用户要求补上信息行(「其实你对标我的选片就行」),故不再自拼片名。
  //  ⚠ 时间用「有效结束」(含映后 / 弃映后即时放宽),与网格口径一致;选片行用官方槽位时间。
  //  ⚠ 卡片外壳**恒为普通白卡**:冲突组的分组语义由外层绿框承担(见 buildConflictGroup),
  //    行再套一层红壳会读成「报警」—— 这是 2026-09-11 去警报化的核心改动。
  const info = filmInfoOf(ctx.cat, s, ctx.mappings.get(s.code));
  const row = screeningRow({
    s,
    cat: ctx.cat,
    cardCls: CARD_SHELL_CLS,
    headTitle: info.title, // 英文名 · 中文名(与影片库 / 我的选片卡同一口径)
    headSub: filmInfoText(info),
    // 拖拽把手只出现在冲突组里(见 row.ts::cardHead 第 1 列)
    headHandle: opts.inConflictGroup ? rankHandle(opts.rank) : undefined,
    hideDate: true,
    timeText: `${s.start_time}–${endHms}`,
    acts: buildActs(ctx, s, talk, opts.inConflictGroup === true, opts.rank),
    rowActs: rowActsOf(s),
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

/** 冲突组内的**拖拽把手** —— 占卡片头第 1 列(见 `row.ts::cardHead` 的 `handle`)。 */
function rankHandle(rank: number | undefined): HTMLElement {
  const h = el(
    "button",
    "w-[18px] h-[18px] mt-[2px] inline-flex items-center justify-center border-0 bg-transparent p-0 " +
      "rounded-4 text-13 leading-none text-faint cursor-grab active:cursor-grabbing " +
      "hover:text-ink hover:bg-[var(--bg-hover-soft)]"
  );
  h.type = "button";
  h.dataset.dragRank = "1";
  h.textContent = "⠿";
  // 触屏:把手上的手势必须由我们接管,否则浏览器会把它当面板滚动吃掉 pointermove
  h.style.touchAction = "none";
  h.dataset.tip = rank
    ? `按住拖动 —— 调整本组抢票顺位(当前第 ${rank} 位)\n顺位 1 = 首选;不同顺位之间允许时间重叠,同一顺位内的场次构成同一套方案`
    : "按住拖动 —— 调整本组抢票顺位";
  return h;
}

/** 冲突组内的**拖动排序**(指针事件:鼠标 / 触屏 / 笔通用,不用 HTML5 DnD)。
 *
 *  **动效**(2026-09-11 加,用户要求「要有明显的动画 —— 拖拽它移动到另一个位置的感觉」):
 *   · 被拿起的那一行 `rank-lift`(抬高 + 强投影 + 品牌色描边)并**逐帧跟手**平移;
 *   · 其余行用 **FLIP**(First-Last-Invert-Play)平滑**让位** —— 记录换位前后的布局位置,
 *     先把它瞬移到旧位置(transform),下一帧放行过渡归零,于是「滑动」而不是「跳变」。
 *
 *  **就近落位**(2026-09-11 二改,用户反馈「放开鼠标这个组件并没有放开 —— 你要看它靠近哪个地方
 *  再把它挤进去,不要每次都要移到特定位置才放得下」):
 *   · 换位判据从「指针 `clientY` 越过邻行中线」改成「**被拿起那一行的视觉中心**越过邻行中心」——
 *     把手钉在卡片**上缘**,拿指针去比中线等于要求「多拖半张卡」,改成比中心则**重叠到一半即落位**;
 *   · **松手时按松手点再落一次位**(见 `finish`)—— 保证「松手那一刻卡片看到在哪」= 「落到的位置」;
 *   · 监听挂 `window`(不再只挂把手)—— 指针捕获一旦丢在把手上,`pointerup` 就送不到,
 *     行会**永远停在「拿起」态**;挂 window 是同一段逻辑的兜底,永不落空。
 *
 *  ⚠ 为什么要**位移补偿** `offset`:行始终留在文档流里(不改成 fixed —— 抽屉有 `overflow-hidden`,
 *    脱离文档流还要处理裁剪 / 滚动,得不偿失)。换位会改它自己的布局位置,若只用「指针位移」当
 *    transform,行会在换位瞬间**跳**一格;`offset -= 布局位移` 把这个跳变抵消掉,视觉上就只剩跟手。
 *  ⚠ 指针捕获挂在**把手上**(不是行上):行内还有 ⓘ / 定位 ▸ / ✕ 等按钮,
 *    捕获到行会让它们的点击判定变复杂。
 *  ⚠ 拖动期间置 `document.body.dataset.rankDragging` —— `main.ts::onHoverLinkMove` 据此跳过
 *    hover 联动(否则同冲突组的每一行都会被 `hl-row` 描边,盖掉「拿起」的投影)。 */
function attachRankDrag(box: HTMLElement): void {
  const rowsIn = (): HTMLElement[] => [...box.querySelectorAll<HTMLElement>("[data-code]")];
  /** FLIP 过渡时长 / 缓动 —— 与「卡片 hover」同量级(120~180ms),比它略长一点才看得出「让位」 */
  const FLIP_MS = 170;
  const FLIP_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

  for (const handle of box.querySelectorAll<HTMLElement>("[data-drag-rank]")) {
    handle.addEventListener("pointerdown", (ev: PointerEvent) => {
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
      const row = handle.closest<HTMLElement>("[data-code]");
      if (!row) return;
      ev.preventDefault(); // 阻止文本选择(拖动中不要选到片名)
      const pid = ev.pointerId;
      const startY = ev.clientY;
      handle.setPointerCapture(pid);
      document.body.dataset.rankDragging = "1";

      let moved = false;
      /** 收尾只跑一次:`pointerup` 与兜底监听可能同帧各来一发(见下面的 window 监听) */
      let done = false;
      /** 指针相对起点的位移(clientY 口径) */
      let dy = 0;
      /** 换位补偿:布局位置移动了多少,就从 transform 里减掉(见函数头 ⚠) */
      let offset = 0;

      const paint = (): void => {
        row.style.transform = `translateY(${dy + offset}px) scale(1.02)`;
      };

      // 「拿起来」:抬高 + 投影 + 轻微放大 —— 与下面正在让位的行拉开层次
      // ⚠ 顺手摘掉残留的 hover 联动类:拖动期间 `main.ts::onHoverLinkMove` 被跳过,
      //   若行在按下前已被 hover 高亮,那个 `hl-*` 会一直挂着(mouseout 也被跳过),
      //   其 `!important` 投影会与「拿起」的投影打架。
      document.querySelectorAll(".hl-card, .hl-row").forEach((n) => n.classList.remove("hl-card", "hl-row"));
      row.classList.add("rank-lift");
      row.style.position = "relative";
      row.style.zIndex = "5";
      paint();

      /** **就近落位**:把行「挤」进离它最近的槽位(只改 DOM 次序,不动别的状态)。
       *
       *  ★ 判据 = **被拿起那一行的视觉中心**,不是指针 `clientY`(2026-09-11 二改,见函数头):
       *    把手在卡片头 → 指针贴着卡片**上缘**,拿它去比邻行中线就得「多拖半张卡」才换得动;
       *    比中心则「与邻卡重叠到一半」即落位,松手时卡片**看到在哪**就**落在哪**。
       *  ⚠ 一律用 `offsetTop / offsetHeight`(布局值),不用 `getBoundingClientRect`:
       *    ① 布局值不含 transform —— 换位后重算判据不变,天然幂等,不会在行边界来回抖;
       *    ② 正在 FLIP 让位的邻行读到的也是**落点**而不是动画中间态,不会被动画带偏。
       *    被拿起那一行自己补上 `dy + offset`(它的 transform),布局值即还原成视觉值。
       *  ⚠ `animate = false`(松手时):跳过让位动画 —— 紧接着 `finish` 会清掉全部内联样式,
       *    动画还没播就被抹掉,白搭一次强制回流。 */
      const settle = (animate = true): void => {
        const center = row.offsetTop + row.offsetHeight / 2 + dy + offset;
        // 插入点:第一张「中心在行中心下方」的行之前;都没有 → 落到末尾
        let target: HTMLElement | null = null;
        for (const r of rowsIn()) {
          if (r === row) continue;
          if (center < r.offsetTop + r.offsetHeight / 2) {
            target = r;
            break;
          }
        }
        // 位置没变就不动 DOM —— 每次 pointermove 都 insertBefore 会反复触发布局,
        // 而布局一变判据就变,在行边界附近容易来回抖(经典 reorder 抖动)。
        const next = row.nextElementSibling as HTMLElement | null;
        if (target ? next === target : next === null) return;

        // ---- 换位:自己补位移(不跳),其余行 FLIP(滑动让位)----
        const others = rowsIn().filter((r) => r !== row);
        const before = animate ? new Map(others.map((r) => [r, r.offsetTop])) : null;
        const selfBefore = row.offsetTop;
        if (target) box.insertBefore(row, target);
        else box.appendChild(row);
        offset -= row.offsetTop - selfBefore;
        paint();
        if (!before) return;

        for (const r of others) {
          const d = before.get(r)! - r.offsetTop;
          if (!d) continue;
          r.style.transition = "none";
          r.style.transform = `translateY(${d}px)`;
        }
        // 强制回流:让上面那批「瞬移到旧位置」先落地,否则与下一帧的归零合并成一次、动画不播
        void box.offsetHeight;
        for (const r of others) {
          if (!r.style.transform) continue;
          r.style.transition = `transform ${FLIP_MS}ms ${FLIP_EASE}`;
          r.style.transform = "translateY(0)";
        }
      };

      const move = (e: PointerEvent): void => {
        if (e.pointerId !== pid) return;
        moved = true;
        dy = e.clientY - startY;
        paint();
        settle();
      };

      const finish = (e: PointerEvent): void => {
        if (done || e.pointerId !== pid) return;
        done = true;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        try {
          handle.releasePointerCapture(pid);
        } catch {
          /* 已释放(pointercancel 等) */
        }
        delete document.body.dataset.rankDragging;
        // ★ 松手前按**松手点**再落一次位:最后一个 pointermove 可能与 pointerup 差几像素
        //   (快速甩动 / 浏览器合并事件),不复算的话「松手那一刻卡片在哪」与「落到哪」会错开。
        //   这里不再播让位动画(animate=false)—— 紧接着的内联样式清理会把动画一起抹掉。
        if (moved) {
          dy = e.clientY - startY;
          paint();
          settle(false);
        }
        // 收干净全部内联样式:顺序未变时 `setRanks` 会早退、DOM 不重建,残留的 transform 会让行错位
        for (const r of rowsIn()) {
          r.classList.remove("rank-lift");
          r.style.removeProperty("position");
          r.style.removeProperty("z-index");
          r.style.removeProperty("transition");
          r.style.removeProperty("transform");
        }
        if (!moved) return; // 只是点了一下把手 → 不改顺序
        const order = rowsIn()
          .map((r) => r.dataset.code ?? "")
          .filter(Boolean);
        setRanks(order); // 顺序未变时内部直接返回(不广播、不重绘)
      };

      // ⚠ 挂 `window` 而不是 `handle`:指针捕获在「行被搬动 / 抽屉重绘」时可能丢失,
      //   一旦丢在把手上,`pointerup` 就送不到 → 行**永远停在「拿起」态**(用户反馈
      //   「放开鼠标这个组件并没有放开」)。挂 window 是同一段逻辑的兜底,永不落空。
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    });
  }
}

/** 行程卡的**卡片头右缘操作组**(`acts`):①「映后 N′」合并标签(点标签 = 含/弃,点数字 = 改本场时长);
 *  ② 顺位徽章(**仅冲突组内的行**);③ ✕ 移出(极淡,卡 hover 才完全显现)。
 *  ⚠ 三枚都是**行程特有**的操作 —— 位置对齐选片卡「片名行右上角图标组」,`ml-auto` 贴右。 */
function buildActs(
  ctx: AgendaCtx,
  s: Screening,
  talk: number,
  inGroup: boolean,
  rank: number | undefined
): HTMLElement {
  const acts = el("div", "flex items-center gap-[6px] shrink-0");

  // ---- ① 映后:一枚标签同时表达「含/弃」与「本场时长」(旧版是 ⏱ N′ + ✓含映后 两枚正交标签) ----
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
      `rounded-5 px-[8px] py-[1px] text-11 font-semibold whitespace-nowrap transition-colors hover:border-biff ${talkOn ? onCls : offCls}`
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

  // ---- ② 抢票顺位徽章(**仅冲突组内的行**)----
  //  顺位 = 方案编号:同一顺位内的场次构成同一套方案(见 plans.ts)。改序的唯一入口是
  //  卡片头第 1 列的拖拽把手(⠿)—— 徽章只读,不再是一枚可点菜单。
  //  配色走 **ok 绿**:顺位是「这组已处理」的证据,与组框同一套语言(去警报化,见 buildConflictGroup)。
  if (inGroup && rank != null) {
    const b = el(
      "span",
      "shrink-0 inline-flex items-center rounded-5 px-[7px] py-px text-11 font-extrabold tabular-nums " +
        "border border-ok bg-[color-mix(in_srgb,var(--color-ok)_12%,var(--color-card))] text-ok whitespace-nowrap",
      `顺位 ${rank}`
    );
    b.dataset.tip =
      `抢票顺位 ${rank} —— 拖动左侧 ⠿ 调整(顺位 1 = 首选)\n` +
      `不同顺位之间可以时间重叠;同一顺位内的场次构成「方案 ${rank}」(见上方「方案对比」)`;
    acts.appendChild(b);
  }

  // ---- ③ ✕ 移出:极淡(hover 才完全显现),避免误触 ----
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

/** 行程卡的**场次行右缘**主操作「定位 ▸」—— 与「我的选片」同款(点 = 网格切到该日期 + 居中 + 闪烁)。
 *  走 `data-jump-code` 复用 `main.ts` 既有委托(`jumpToScreening`),不需要新增事件分支。 */
function locateBtn(s: Screening): HTMLElement {
  const b = el("button", BTN_GO_SM, "定位 ▸");
  b.dataset.jumpCode = s.code;
  b.dataset.tip = "在网格中定位本场(切到该日期,横向居中并闪烁高亮)";
  return b;
}

/** 票价章 —— 官网价目表口径(见 `extras.ts::priceOf`):抢票前先看清「这场要花多少」。
 *  放在场次行右缘(与「定位 ▸」同组),卡头右缘留给映后 / 顺位 / ✕。 */
function priceChip(s: Screening): HTMLElement {
  const krw = priceOf(s);
  const chip = el(
    "span",
    "text-11 font-bold text-ink-2 tabular-nums whitespace-nowrap cursor-help",
    formatKrw(krw)
  );
  chip.dataset.tip =
    `票价 ${formatKrw(krw)}\n` +
    "开闭幕式 ₩30,000 · Actors' House / Master Class ₩15,000 · Midnight Passion ₩20,000\n" +
    "普通场次 / Cine Class ₩10,000;老人(1961 年前生)/ 残障 / 退伍军人可减 ₩3,000(需证件核验)";
  return chip;
}

/** 行程卡**场次行右缘**操作组:票价 + 「定位 ▸」(两枚贴场次走) */
function rowActsOf(s: Screening): HTMLElement {
  const box = el("div", "flex items-center gap-[6px]");
  box.appendChild(priceChip(s));
  box.appendChild(locateBtn(s));
  return box;
}

/* ---------------- 顺位撞车(顺位互相打架) ---------------- */

/** 「顺位撞车」提示块 —— 两个及以上冲突组在**同一层**上撞到同一部片(见 `plans.ts::RankClash`)。
 *
 *  ★ 为什么值得单独提示(2026-09-12,用户报的真实场景):
 *    行程里同时留着「同一部片的两天场次」是**抢票备选**,但若两组的同一层都排到了这部片,
 *    那一层的组合会被「同一部片只留一场」剔除(见 `plans.ts` 文件头)⇒
 *    用户看不出「为什么这一层不是每组都取那场」。
 *  本块逐条给出**让路**按钮(把该组这一层的场次与组内第一个不同片的场次**交换**),
 *  顶部再给一枚**一键全部修复** —— 先出预览、确认后才执行(见 `renderRankFixPreview`)。
 *
 *  配色走**黄**(`text-tight`)而不是红:它不是「两场不能都看」那种硬冲突(那是红),
 *  而是「你的偏好次序需要二选一」的可决策状态。 */
function buildRankClashNote(ctx: AgendaCtx): HTMLElement | null {
  const clashes = ctx.plans.rankClashes;
  if (clashes.length === 0) return null;
  const wrap = el(
    "div",
    "grid gap-[8px] rounded-8 border border-tight p-[10px] " +
      "bg-[color-mix(in_srgb,var(--color-tight)_9%,var(--color-card))]"
  );

  // 头部:标题 + 一键全部修复(带预览)
  const head = el("div", "flex items-center gap-[8px] flex-wrap");
  const firstLayer = clashes.filter((c) => c.layer === 1).length;
  head.appendChild(
    el(
      "span",
      "text-12 font-bold text-tight",
      firstLayer ? `${firstLayer} 个冲突组在第 1 顺位撞到同一部片` : `${clashes.length} 处顺位撞车`
    )
  );
  head.appendChild(el("span", "text-11 text-muted", "同一层里的同片重复会被剔除 —— 让一组让路即可恢复"));
  const preview = el("div", "grid gap-[6px]");
  const fixAll = el("button", BTN_GO_SM, "一键全部修复");
  fixAll.dataset.tip =
    "自动把撞车的组依次让路,直到每层都不重复;\n会**先给你看**要改哪几组、改成什么顺序,确认后才生效";
  fixAll.addEventListener("click", () => {
    renderRankFixPreview(ctx, preview, autoFixRanks(ctx.plans.groups, ctx.filmKeyOf));
  });
  head.appendChild(fixAll);
  wrap.appendChild(head);
  wrap.appendChild(preview);

  for (const clash of clashes) {
    const first = ctx.cat.byCode.get(clash.spots[0].code);
    const film = first ? displayTitle(first, ctx.mappings.get(first.code)?.title_cn) : clash.filmKey;
    wrap.appendChild(
      el(
        "div",
        "text-12 font-bold text-tight",
        `第 ${clash.layer} 顺位 · ${clash.spots.length} 个冲突组都把《${film}》排在这里`
      )
    );

    const btns = el("div", "flex items-center gap-[6px] flex-wrap");
    clash.spots.forEach((spot, si) => {
      const label = groupLabel(ctx, [spot.code]);
      if (spot.alt === null) {
        // 组内其余场次全是同一部片 → 这组无处可让,只能让别的组让路
        const dead = el("span", "text-11 text-faint", `${label} 组:组内其余场次都是同一部片,无法让路`);
        dead.dataset.tip = "该冲突组里除这一场,其余场次也都是这部片 —— 让这一组让路解决不了问题";
        btns.appendChild(dead);
        return;
      }
      const btn = el("button", BTN_GO_SM, `${label} 组改选 ${spot.alt}`);
      btn.dataset.tip =
        `把「${label}」这组第 ${clash.layer} 顺位的 ${spot.code} 与 ${spot.alt} 交换,\n` +
        "其余场次的相对次序不变";
      btn.addEventListener("click", () => applySpotFix(ctx, clash, si));
      btns.appendChild(btn);
    });
    wrap.appendChild(btns);
  }
  return wrap;
}

/** 交换某组内两个场次的位置并落盘(逐条让路的唯一出口)。
 *  顺序未变时 `setRanks` 会早退(不广播、不重绘),故无需自己判重。 */
function applySpotFix(ctx: AgendaCtx, clash: RankClash, spotIndex: number): void {
  const spot = clash.spots[spotIndex];
  if (spot.alt === null) return;
  const group = ctx.plans.groups[spot.group];
  if (!group) return;
  const i = group.indexOf(spot.code);
  const j = group.indexOf(spot.alt);
  if (i < 0 || j < 0) return;
  const next = [...group];
  [next[i], next[j]] = [next[j], next[i]];
  setRanks(next);
}

/** 一键修复的**预览** —— 列出会改的组(before ⇒ after),确认后才执行。
 *  `changes` 为空时只出说明不出按钮(无处可让 / 已经干净)。 */
function renderRankFixPreview(ctx: AgendaCtx, box: HTMLElement, plan: RankFixPlan): void {
  box.replaceChildren();
  if (plan.changes.length === 0) {
    box.appendChild(
      el(
        "div",
        "text-11 text-muted",
        plan.remaining.length
          ? "没有可让路的场次 —— 每个撞车组里除撞车的那一场,其余场次也都是同一部片。"
          : "顺位已经是干净的,无需修复。"
      )
    );
    return;
  }
  box.appendChild(el("div", "text-11 text-muted", `将调整 ${plan.changes.length} 个组的顺位:`));
  for (const ch of plan.changes) {
    const first = ctx.cat.byCode.get(ch.before[0]);
    const label = first ? dateInfo(first.date).label : ch.before[0];
    const beforeTxt = ch.before.map((c) => shortCode(ctx, c)).join(" → ");
    const afterTxt = ch.after.map((c) => shortCode(ctx, c)).join(" → ");
    box.appendChild(el("div", "text-11 text-ink-2 tabular-nums", `${label} · ${beforeTxt}  ⇒  ${afterTxt}`));
  }
  if (plan.remaining.length) {
    box.appendChild(el("div", "text-11 text-tight", `另有 ${plan.remaining.length} 处撞车未能自动修复(无处可让)`));
  }
  const acts = el("div", "flex items-center gap-[6px]");
  const ok = el("button", BTN_GO_SM, "确认执行");
  ok.addEventListener("click", () => {
    for (const ch of plan.changes) setRanks(ch.after);
  });
  const cancel = el(
    "button",
    "border border-line bg-card rounded-5 px-[7px] py-[2px] text-11 font-bold text-ink whitespace-nowrap " +
      "hover:border-line-strong hover:bg-hover",
    "取消"
  );
  cancel.addEventListener("click", () => box.replaceChildren());
  acts.append(ok, cancel);
  box.appendChild(acts);
}

/** 冲突组的短标签(取组内首场的日期 + 时间)—— 预览 / 按钮上指代「哪一组」 */
function groupLabel(ctx: AgendaCtx, codes: string[]): string {
  const s = ctx.cat.byCode.get(codes[0]);
  return s ? `${dateInfo(s.date).label} ${s.start_time.slice(0, 5)}` : codes[0];
}

/** 场次短标签:`19:00·375`(预览里读顺序用) */
function shortCode(ctx: AgendaCtx, code: string): string {
  const s = ctx.cat.byCode.get(code);
  return s ? `${s.start_time.slice(0, 5)}·${code}` : code;
}

/* ---------------- 已保存方案(替换原「枚举对比」区) ---------------- */

/** 「第一顺位方案」的场次集合 = 各组顺位 1 + 共同场次(见 `plans.ts` 文件头)。
 *  这是行程里**最优的那一套**,也是「保存方案」存下来的东西 —— 落选的备选不进方案。 */
function topPlanCodes(ps: PlanSet): string[] {
  return [...ps.common, ...ps.groups.map((g) => g[0])];
}

/** 已保存方案区 —— 用户手动存下来的快照列表(2026-09-12 替换原「枚举对比」)。
 *  顶部「保存当前方案」把**当前第一顺位方案**存下来(场次集合相同则去重,见 `state.ts::savePlan`);
 *  每行给名称 / 场次数 / 日期区间 / 删除。
 *  ⚠ 第一顺位有撞车时**禁用保存** —— 那一套里会有同片重复,存下来就是个「有冲突的方案」。 */
function buildSavedPlans(ctx: AgendaCtx): HTMLElement {
  const wrap = el("div", "grid gap-[8px] pb-[12px] border-b border-line-strong");
  const head = el("div", "flex items-center gap-[8px] flex-wrap");
  head.appendChild(el("span", "text-14 font-bold text-ink", `已保存方案 · ${savedPlans.length} 套`));

  const firstLayerClash = ctx.plans.rankClashes.some((c) => c.layer === 1);
  const save = el("button", BTN_GO_SM, "保存当前方案");
  save.dataset.tip = firstLayerClash
    ? "第一顺位有撞车(见上方提示)—— 先让路再保存,否则存下来的是「同一部片排两场」的方案"
    : "把当前**第一顺位方案**存成一个快照(每个冲突组取顺位 1 的那场 + 共同场次);场次集合相同不会重复存";
  if (firstLayerClash) {
    save.disabled = true;
    save.className += " opacity-45 cursor-not-allowed";
  } else {
    save.addEventListener("click", () => {
      const r = savePlan(topPlanCodes(ctx.plans));
      if (r.ok && r.plan) toast(`已保存为「${r.plan.name}」(${r.plan.codes.length} 场)`);
      else if (r.reason === "duplicate") toast("这套方案已经存过了");
      else toast("还没有选片,先加入行程");
    });
  }
  head.appendChild(save);
  wrap.appendChild(head);

  if (savedPlans.length === 0) {
    wrap.appendChild(
      el(
        "div",
        "text-11 text-muted",
        "还没有保存方案 —— 点「保存当前方案」把当前第一顺位方案存下来;导出 / 分享时按方案导出。"
      )
    );
    return wrap;
  }

  const list = el("div", "grid gap-[6px]");
  for (const p of savedPlans) list.appendChild(savedPlanRow(ctx, p));
  wrap.appendChild(list);
  return wrap;
}

/** 一行已保存方案:名称 + 概要(场次数 / 日期区间 / 失效场次)+ 删除。 */
function savedPlanRow(ctx: AgendaCtx, p: SavedPlan): HTMLElement {
  const row = el("div", "flex items-center gap-[8px] rounded-7 border border-line bg-card px-[9px] py-[6px]");
  row.appendChild(el("span", "text-12 font-bold text-ink shrink-0", p.name));

  const shows = p.codes
    .map((c) => ctx.cat.byCode.get(c))
    .filter((s): s is Screening => Boolean(s))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
  const gone = p.codes.length - shows.length;
  const bits: string[] = [`${shows.length} 场`];
  if (shows.length) {
    const first = dateInfo(shows[0].date).label;
    const last = dateInfo(shows[shows.length - 1].date).label;
    bits.push(first === last ? first : `${first}–${last}`);
  }
  if (gone > 0) bits.push(`${gone} 场已不在排期`);
  const outline = el("span", "text-11 text-muted flex-1 min-w-0 truncate tabular-nums", bits.join(" · "));
  outline.dataset.tip = p.codes.map((c) => shortCode(ctx, c)).join("\n");
  row.appendChild(outline);

  const del = el(
    "button",
    "shrink-0 border-0 bg-transparent p-0 w-[20px] h-[20px] inline-flex items-center justify-center " +
      "text-12 text-faint rounded-4 hover:text-conf hover:bg-[var(--bg-hover-soft)]",
    "✕"
  );
  del.setAttribute("aria-label", `删除${p.name}`);
  del.dataset.tip = `删除「${p.name}」(不影响行程)`;
  del.addEventListener("click", () => deletePlan(p.id));
  row.appendChild(del);
  return row;
}

/* ---------------- 冲突组「顺位卡」 ---------------- */

/** 冲突组「顺位卡」:同一时间带互相重叠的几场折叠成一张卡 ——
 *  组内**按抢票顺位排序**(顺序来自 `plans.groups`,已由 `plans.ts` 归一),
 *  拖动卡片头第 1 列的 ⠿ 改序;顺位徽章在卡片头右缘。
 *
 *  ★ 2026-09-11 **去警报化**(用户原话「我觉得这样是不是需要表示这样的顺位下是 OK 的」):
 *    顺位接手之后,**重叠不再是错误状态** —— 它自动展开成 N 套各自可行的方案,
 *    红色只剩「这两场不能都看」这个事实。故本卡从**红框警报**降级为**绿框 OK**:
 *    标题用墨色陈述「N 场重叠」,右边挂一枚绿色 `✓ 顺位已排`;组内行也回普通白卡。
 *  ⚠ **红色只留给真异常** `broken`(`plans.invalid` 非空 = 同一顺位内仍重叠,理论不会发生)。
 *  ⚠ 甘特图红卡与顶栏「冲突 N」**刻意不动** —— 它们表达的是「同一时间轴上不能同时看两场」,
 *    选片时是有用的事实标记,不是错误计数(见 `PLAN-20260911223000` 迭代记录)。
 *
 *  @param broken 本组是否含「同一顺位内仍重叠」的场次(异常态,唯一保留红色的情形) */
function buildConflictGroup(ctx: AgendaCtx, group: string[], broken: Set<string>): HTMLElement {
  const shows = group
    .map((c) => ctx.cat.byCode.get(c))
    .filter((s): s is Screening => Boolean(s));
  const isBroken = group.some((c) => broken.has(c));
  const box = el(
    "div",
    `grid gap-[8px] rounded-8 border-2 bg-card p-[10px] ${isBroken ? "border-conf" : "border-ok"}`
  );
  if (shows.length) {
    const from = shows.map((s) => s.start_time).sort()[0].slice(0, 5);
    const to = fmtEndClock(Math.max(...shows.map((s) => hmsToMin(s.end_time))));
    const head = el("div", "grid gap-[3px]");
    const line = el("div", "flex items-center gap-[8px] flex-wrap");
    line.appendChild(
      el("span", `text-12 font-bold ${isBroken ? "text-conf" : "text-ink"}`, `${from}–${to} · ${shows.length} 场重叠`)
    );
    if (isBroken) {
      const bad = el("span", "text-11 font-extrabold text-conf", "方案内部仍重叠");
      bad.dataset.tip = "有的组合内部仍然撞车(冲突口径有洞)—— 已把这类组合从「方案对比」里剔除";
      line.appendChild(bad);
    } else {
      const ok = el(
        "span",
        "inline-flex items-center gap-[4px] rounded-5 border border-ok px-[7px] py-px text-11 font-extrabold " +
          "bg-[color-mix(in_srgb,var(--color-ok)_12%,var(--color-card))] text-ok whitespace-nowrap",
        "✓ 已排偏好次序"
      );
      ok.dataset.tip =
        "顺位只表达**偏好次序**(顺位 1 = 最想要),不决定分组 ——\n" +
        "方案 = 「每个冲突组各取一场」的所有组合,每一套都无冲突(见上方「方案对比」);\n" +
        "顺位的作用只有一个:给方案排序(成本 = 各组所选顺位之和,越小越优先)";
      line.appendChild(ok);
    }
    head.appendChild(line);
    head.appendChild(
      el(
        "span",
        "text-11 text-muted",
        "拖动左侧 ⠿ 调偏好次序 —— 顺位越小越优先;换完之后方案会重新排序,每一套都无冲突"
      )
    );
    box.appendChild(head);
  }
  shows.forEach((s, i) => {
    box.appendChild(buildRow(ctx, s, { inConflictGroup: true, rank: i + 1 }));
  });
  attachRankDrag(box);
  return box;
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
    txt += " · 赶不上";
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
