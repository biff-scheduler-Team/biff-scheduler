// 选片打标(wish)共享层 —— 三档顺序 / 色类 / 分段控件构造。
// 「影片库」行内三选、「我的选片」总览、影片详情弹层 共用同一套档位语义与视觉,
// 避免多处各写一份 must/maybe/wild 文案与色类(Tailwind v4 只生成源码完整出现的类)。
//
// 三档配色 = 冷色系(蓝 `--pri-must` / 紫 `--pri-maybe` / 灰蓝 `--pri-wild`):
// 色点画在甘特卡上,而卡底是红绿灯(绿=已选 / 黄=时间紧张 / 红=冲突),
// 故档位整族搬离红黄绿 —— 与底色正交才能一眼看出「是不是我想看的」。

import type { Priority } from "./types";
import { el } from "./util";

/** 档位顺序(必看 → 备选 → 随缘),列表排序与 seg 展示同源 */
export const WISH_ORDER: [Priority, string][] = [
  ["must", "必看"],
  ["maybe", "备选"],
  ["wild", "随缘"],
];

export const PRI_LABEL: Record<Priority, string> = { must: "必看", maybe: "备选", wild: "随缘" };

/** seg / 章 on 态完整字面量(勿改回动态拼接) */
export const PRI_BG_ON: Record<Priority, string> = {
  must: "bg-pri-must text-on-brand",
  maybe: "bg-pri-maybe text-on-brand",
  wild: "bg-pri-wild text-on-brand",
};

/** 档位小色点(甘特卡标题行前的打标标记)完整字面量 */
export const PRI_DOT_BG: Record<Priority, string> = {
  must: "bg-pri-must",
  maybe: "bg-pri-maybe",
  wild: "bg-pri-wild",
};

/** 档位纯文字色 —— 只给「不足以放一枚 Tag」的极小字用(如评分分项说明)。
 *  常规场景请用 priTag():档位以统一微圆角 Tag 呈现,别再以纯文本混进标题里。 */
export const PRI_TEXT: Record<Priority, string> = {
  must: "text-pri-must",
  maybe: "text-pri-maybe",
  wild: "text-pri-wild",
};

/** 档位 Tag 配色 —— 统一微圆角标签(浅底 + 同族深字)。
 *  浅底走 --pri-*-soft token:与红绿灯底色(红/黄/绿)整族错开,落在任何底色上都不撞。 */
export const PRI_TAG: Record<Priority, string> = {
  must: "bg-pri-must-soft text-pri-must",
  maybe: "bg-pri-maybe-soft text-pri-maybe",
  wild: "bg-pri-wild-soft text-pri-wild",
};

/** 统一档位 Tag(必看 / 备选 / 随缘)—— 建议行程、未纳入原因、行程行等处共用同一枚。
 *  之前各处把档位写成 `text-pri-*` 纯文本混在标题里,视觉上不成体系,故收口到这里。 */
export function priTag(p: Priority, extraCls?: string): HTMLElement {
  return el(
    "span",
    "inline-flex items-center rounded-[5px] px-[6px] py-px text-[10.5px] font-bold leading-[1.5] whitespace-nowrap " +
      PRI_TAG[p] +
      (extraCls ? " " + extraCls : ""),
    PRI_LABEL[p]
  );
}

export interface WishSegOpts {
  /** 当前档位;undefined = 未打标 */
  cur: Priority | undefined;
  /** 点击回调:点非同档 = 切到该档;点当前档 = null(取消打标) */
  onPick: (next: Priority | null) => void;
  size?: "sm" | "md";
  /** title 前缀(如「我的选片 · 」) */
  tipPrefix?: string;
  extraCls?: string;
}

/** 三档分段控件(必看/备选/随缘):当前档实心着色,再点同档取消 */
export function buildWishSeg(o: WishSegOpts): HTMLElement {
  const sm = o.size !== "md";
  const seg = el(
    "div",
    "inline-flex border border-line rounded-full overflow-hidden bg-card" + (o.extraCls ? " " + o.extraCls : "")
  );
  WISH_ORDER.forEach(([p, label], i) => {
    const on = o.cur === p;
    const stateCls = on ? PRI_BG_ON[p] : "bg-card text-muted hover:text-ink";
    const sepCls = i > 0 ? " border-l border-line" : "";
    const pad = sm ? "px-2 py-[2px] text-[11px]" : "px-[9px] py-[3px] text-[12px]";
    const b = el(
      "button",
      `border-0 ${pad} font-semibold transition-[background,color] duration-[120ms] ease-in-out ${stateCls}${sepCls}`,
      label
    );
    b.dataset.tip = `${o.tipPrefix ?? ""}标为「${label}」${on ? "(再点取消打标)" : " — 供「智能排片」生成行程"}`;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation(); // 三选常嵌在可点容器内(影片库行 / 甘特卡),避免顺带触发展开或选中
      o.onPick(on ? null : p);
    });
    seg.appendChild(b);
  });
  return seg;
}

/* ---------- 档位徽章(单枚控件 + 点击弹出小菜单) ----------
 * 2026-09-10 加(见 PLAN-20260910171800):「必看/备选/随缘」三段平铺在**一行里出现两次**
 * (左栏影片行 + 右栏选片行),视觉上是一整排重复按钮。改成**一枚徽章**:常态只显示当前档位
 * (就是用户要的「颜色标签」),点击才弹出三档 + 清除。
 * ⚠ 菜单必须 `position: fixed`:两个列表容器都是 `overflow-y-auto`,绝对定位的弹层会被裁掉。
 * ⚠ 菜单挂在 `document.body`(不在 `#modal-root` 内),故必须自己处理「点外面 / 滚动 → 关」。 */

let wishMenuEl: HTMLElement | null = null;
let wishMenuBound = false;

function closeWishMenu(): void {
  wishMenuEl?.remove();
  wishMenuEl = null;
}

/** 文档级一次性监听:点菜单外 / 任意滚动 → 收起。
 *  故意**不**接 Esc —— modal.ts 的 Esc 是模块级单监听且注册更早,这里抢不到,接了反而会连弹层一起关。 */
function bindWishMenuOnce(): void {
  if (wishMenuBound) return;
  wishMenuBound = true;
  document.addEventListener(
    "pointerdown",
    (ev) => {
      if (!wishMenuEl) return;
      if ((ev.target as HTMLElement | null)?.closest?.("[data-wish-menu]")) return;
      closeWishMenu();
    },
    true
  );
  document.addEventListener("scroll", closeWishMenu, true);
}

function openWishMenu(anchor: HTMLElement, cur: Priority | null, onPick: (p: Priority | null) => void): void {
  bindWishMenuOnce();
  if (wishMenuEl) {
    const same = wishMenuEl.dataset.wishMenu === anchor.dataset.wishAnchor;
    closeWishMenu();
    if (same) return; // 再点同一枚徽章 = 收起
  }
  const menu = el(
    "div",
    "fixed z-[250] bg-card border border-line rounded-[9px] shadow-[var(--shadow-modal)] p-[4px] min-w-[112px] grid gap-px"
  );
  menu.dataset.wishMenu = anchor.dataset.wishAnchor ?? "";
  const opts: [Priority | null, string][] = [
    ...WISH_ORDER.map(([p, label]) => [p, label] as [Priority | null, string]),
    [null, "清除档位"],
  ];
  for (const [p, label] of opts) {
    const on = cur === p;
    const b = el(
      "button",
      `w-full text-left border-0 rounded-[6px] px-[9px] py-[5px] text-[12px] font-semibold whitespace-nowrap ${
        on ? "bg-raised text-ink" : "bg-transparent text-ink-2 hover:bg-[var(--bg-hover-soft)]"
      }`,
      `${on ? "✓ " : ""}${label}`
    );
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeWishMenu();
      onPick(p);
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);

  // 定位:默认贴徽章下方右对齐;下方放不下翻到上方;两侧各留 8px
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  wishMenuEl = menu;
}

/* ---------- 档位**图标**(影片行右上角,2026-09-10 加,见 PLAN-20260910184745 §8) ----------
 * 需求原话:「移除『必看』按钮…改为一个图标(如⭐),hover 时显示文字」——
 * 带文字的档位徽章 + ⓘ + ✕ 三枚控件挤在片名行里,把片名挤成 0 宽、视觉噪声也大。
 * 现在常态只有**一枚星标**:★ = 已定档(按档位着色)/ ☆ = 未设;文字只走 hover 提示
 * (`data-tip`,与全站 tooltip 同源);点击仍弹**同一个** 必看 / 备选 / 随缘 / 清除 菜单。 */

export interface WishIconOpts {
  /** 当前档位;null / undefined = 未设 */
  cur: Priority | null | undefined;
  /** 选中某档 / 清除档位(null) */
  onPick: (next: Priority | null) => void;
  /** title 前缀(如「我的选片 · 」) */
  tipPrefix?: string;
  /** 稳定锚点(菜单回关判定用),一般传影片 key */
  anchor?: string;
}

/** 档位星标 —— 图标化入口,与 wishBadge() 共用同一个弹出菜单(openWishMenu)。 */
export function wishIcon(o: WishIconOpts): HTMLElement {
  const cur = o.cur ?? null;
  const b = el(
    "button",
    "shrink-0 border-0 bg-transparent p-0 w-[20px] h-[20px] inline-flex items-center justify-center " +
      "rounded-[5px] text-[13px] leading-none transition-[color,background-color] duration-[120ms] " +
      "hover:bg-[var(--bg-hover-soft)] " +
      (cur ? PRI_TEXT[cur] : "text-faint hover:text-ink")
  );
  b.dataset.wishAnchor = o.anchor ?? o.tipPrefix ?? "wish";
  b.textContent = cur ? "★" : "☆";
  b.dataset.tip = `${o.tipPrefix ?? ""}档位「${cur ? PRI_LABEL[cur] : "未设"}」— 点击选 必看 / 备选 / 随缘,或清除档位`;
  b.addEventListener("click", (ev) => {
    ev.stopPropagation(); // 嵌在可点容器内(片名行),避免顺带展开 / 折叠
    openWishMenu(b, cur, o.onPick);
  });
  return b;
}
