// 抢票信息:顶栏「开票倒计时」横幅 + 「抢票信息」弹层(开票批次 / 票价 / 须知 / 开闭幕式 / 开票日历)。
//
// 倒计时**同时给北京时间与韩国时间** —— 官网印的是 KST(如 `Sep 17(Thu) 14:00`),
// 人在国内看的是北京时间(= KST − 1h),两者并排,不必自己换算。

import { el } from "./util";
import { openModal } from "./modal";
import { toast } from "./toast";
import { buildTicketIcs, downloadIcs } from "./ics";
import { countdownText, extras, formatKrw, nextTicketOpen, ticketOpens, type TicketOpen } from "./extras";

/** 开票批次里的**关键须知**中文摘要 —— 按关键词匹配官网英文原文(不按行号,官网改版也不会错位);
 *  匹配不上的条目原样显示英文,不硬译。 */
const NOTE_ZH: [RegExp, string][] = [
  [/Chrome/i, "推荐用 Chrome 浏览器购票"],
  [/pop-up/i, "购票页打不开时,检查浏览器「拦截弹窗」设置"],
  [/Multiple sessions|simultaneous logins/i, "同一账号不允许重复登录 / 多设备同时购票"],
  [/tablet/i, "平板设备购票可能异常"],
  [/queue number/i, "高流量时会发排队号依次放行;每场限购 2 张,换场次要重新排队"],
  [/Call Center/i, "查不到订单时打 BIFF 客服 1666-9177"],
];

/** 开闭幕式时间表的中文映射(官网只有英文短语) */
const SLOT_ZH: Record<string, string> = {
  "Audience Entrance": "观众入场",
  "Red Carpet Event": "红毯",
  "Main event": "主活动",
  "Screening of": "开/闭幕片放映",
};

let bannerYear = 0;
let lastBannerText = "";
let timer: number | undefined;

/** 顶栏横幅:未到开票 → 倒计时;已过全部批次 → 「售票中」。文案没变就不写 DOM(每秒 tick 零成本)。 */
function renderTicketBanner(): void {
  const banner = document.getElementById("ticket-banner");
  if (!banner) return;
  const opens = ticketOpens(bannerYear);
  if (opens.length === 0) {
    banner.classList.add("is-hidden");
    return;
  }
  const now = Date.now();
  const next = nextTicketOpen(bannerYear, now);
  let text: string;
  let tip: string;
  if (next) {
    // ⚠ 不能用 `opens.indexOf(next)`:`ticketOpens()` 每次返回**新对象**,引用比较恒为 -1(会印出「第 0 批」)
    const idx = opens.findIndex((o) => o.at === next.at) + 1;
    text = `距第 ${idx} 批开票 ${countdownText(next.at - now)} · 京 ${next.bj} / 韩 ${next.kst}`;
    tip = `第 ${idx} 批开票倒计时\n韩国时间 ${next.kst}(KST) · 北京时间 ${next.bj}\n本批包含:${next.includes}\n点击查看抢票信息(批次 / 票价 / 须知 / 开票日历)`;
  } else {
    text = "BIFF 2026 售票中 · 抢票信息";
    tip = "全部批次均已开票 —— 点击查看票价 / 购票须知 / 开票批次";
  }
  if (text !== lastBannerText) {
    lastBannerText = text;
    banner.textContent = text;
  }
  banner.dataset.tip = tip;
  banner.classList.remove("is-hidden");
}

/** 启动倒计时(每秒 tick;幂等,重复调用不会叠加定时器) */
export function startTicketTicker(year: number): void {
  bannerYear = year;
  renderTicketBanner();
  if (timer === undefined) timer = window.setInterval(renderTicketBanner, 1000);
}

/* ---------------- 「抢票信息」弹层 ---------------- */

function section(title: string): HTMLElement {
  const box = el("section", "border-t border-line pt-[10px]");
  box.appendChild(el("div", "text-13 font-bold mb-[6px]", title));
  return box;
}

function batchCard(open: TicketOpen, index: number, nowMs: number): HTMLElement {
  const card = el("div", "border border-line rounded-9 px-[10px] py-[8px] grid gap-[3px]");
  const head = el("div", "flex items-baseline gap-2 flex-wrap");
  head.appendChild(el("span", "text-13 font-extrabold text-biff-ink", `第 ${index} 批`));
  head.appendChild(el("span", "text-12 text-muted tabular-nums", `韩国 ${open.kst} · 北京 ${open.bj}`));
  const remain = open.at - nowMs;
  head.appendChild(
    el(
      "span",
      remain > 0
        ? "text-12 font-bold text-ok tabular-nums"
        : "text-12 font-semibold text-muted",
      remain > 0 ? `还有 ${countdownText(remain)}` : "已开票"
    )
  );
  card.appendChild(head);
  card.appendChild(el("div", "text-12 text-ink-2 leading-[1.55]", `包含 · ${open.includes}`));
  card.appendChild(el("div", "text-11 text-muted", `官网原文 · ${open.raw}`));
  return card;
}

export function openTicketingModal(): void {
  const body = el("div", "grid gap-[14px]");
  const ex = extras();

  if (!ex) {
    body.appendChild(
      el(
        "div",
        "text-13 text-muted leading-[1.7]",
        "未加载到官网辅助信息(festival-extras.json 缺失)。可直接访问官网 Booking Information 查看开票时间与票价。"
      )
    );
    openModal("抢票信息", body, "lg");
    return;
  }

  const year = Number((ex.generated_at || "").slice(0, 4)) || new Date().getFullYear();
  const opens = ticketOpens(year);
  const now = Date.now();

  // ---- 开票批次 ----
  if (opens.length) {
    const box = el("section");
    box.appendChild(el("div", "text-13 font-bold mb-[6px]", "开票时间(官网 Booking Information)"));
    const list = el("div", "grid gap-[8px]");
    opens.forEach((o, i) => list.appendChild(batchCard(o, i, now)));
    box.appendChild(list);
    const tip = el(
      "div",
      "text-11 text-muted mt-[6px] leading-[1.6]",
      "官网印的是韩国时间(KST);北京时间 = KST − 1 小时。高流量时按排队号依次放行。"
    );
    box.appendChild(tip);
    body.appendChild(box);
  }

  // ---- 票价 ----
  if (ex.ticketing.prices.length) {
    const box = section("票价");
    for (const p of ex.ticketing.prices) {
      const row = el("div", "flex items-baseline justify-between gap-3 text-13 py-[2px]");
      row.appendChild(el("span", "text-ink-2", p.label));
      row.appendChild(el("span", "font-bold tabular-nums", formatKrw(p.krw)));
      box.appendChild(row);
    }
    if (ex.ticketing.discountKrw) {
      box.appendChild(
        el(
          "div",
          "text-12 text-muted mt-[5px] leading-[1.6]",
          `折扣 −${formatKrw(ex.ticketing.discountKrw)}:65 岁以上(1961 年前出生)/ 残障 / 退伍军人,需证件核验`
        )
      );
    }
    body.appendChild(box);
  }

  // ---- 购票须知 ----
  if (ex.ticketing.notes.length) {
    const box = section("购票须知");
    for (const note of ex.ticketing.notes) {
      const zh = NOTE_ZH.find(([re]) => re.test(note))?.[1];
      const item = el("div", "text-12 leading-[1.65] flex gap-[6px] items-start py-[1px]");
      item.appendChild(el("span", "text-biff-ink shrink-0", "·"));
      item.appendChild(el("span", "text-ink-2 min-w-0", zh ? `${zh}` : note));
      box.appendChild(item);
    }
    body.appendChild(box);
  }

  // ---- 开闭幕式(红毯 / 主活动 / 放映 + 交通管制)----
  const cer = ex.ceremony;
  if (cer.slots.length) {
    const box = section("开闭幕式 · 红毯时间表");
    box.appendChild(
      el(
        "div",
        "text-12 text-muted mb-[6px]",
        `开幕 ${cer.openingDate || "—"} · 闭幕 ${cer.closingDate || "—"}(两场同一时间表)`
      )
    );
    for (const s of cer.slots) {
      const row = el("div", "flex items-baseline gap-[10px] text-13 py-[2px]");
      row.appendChild(el("span", "font-bold tabular-nums text-biff-ink w-[104px] shrink-0", s.time));
      row.appendChild(el("span", "text-ink-2", SLOT_ZH[s.text] ?? s.text));
      box.appendChild(row);
    }
    if (cer.traffic.length) {
      box.appendChild(
        el("div", "text-12 font-bold mt-[10px] mb-[3px]", "当天周边交通管制(开幕 / 闭幕两日)")
      );
      for (const t of cer.traffic) {
        const row = el("div", "flex items-baseline gap-[10px] text-12 py-[1px]");
        row.appendChild(el("span", "tabular-nums text-muted w-[104px] shrink-0", t.window));
        row.appendChild(el("span", "text-ink-2", t.road));
        box.appendChild(row);
      }
      box.appendChild(
        el("div", "text-11 text-muted mt-[4px]", "封路时段内建议改乘公共交通;BCC 周边无指定车位")
      );
    }
    body.appendChild(box);
  }

  // ---- 底部:开票日历 + 官网出处 ----
  const foot = el("section", "border-t border-line pt-[10px] flex items-center gap-3 flex-wrap");
  const icsBtn = el(
    "button",
    "border-0 rounded-6 px-[12px] py-[6px] text-12 font-bold text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05]",
    "加入日历提醒(.ics)"
  );
  icsBtn.dataset.tip = "把两批开票时刻导出成日历事件(含提前 30 分钟提醒)—— 导入手机日历即可";
  icsBtn.addEventListener("click", () => {
    if (!opens.length) {
      toast("没有可导出的开票时间");
      return;
    }
    downloadIcs(buildTicketIcs(opens, 30, ex.ticketing.url), "biff2026-tickets.ics");
    toast(`已导出 ${opens.length} 个开票提醒,导入日历后按手机时区显示`);
  });
  foot.appendChild(icsBtn);
  const link = document.createElement("a");
  link.href = ex.ticketing.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.className = "text-12 font-semibold";
  link.textContent = "官网 Booking Information ↗";
  foot.appendChild(link);
  body.appendChild(foot);

  openModal("抢票信息 · BIFF 2026", body, "lg");
}
