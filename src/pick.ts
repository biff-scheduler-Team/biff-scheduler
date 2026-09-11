// 选片打标(wish)共享层 —— 三档顺序 / 色类 / ★ 星标控件构造。
// 「影片库」卡片、「我的行程」行程卡、影片资料弹层 共用同一套档位语义与视觉,
// 避免多处各写一份 must/maybe/wild 文案与色类(Tailwind v4 只生成源码完整出现的类)。
// ⚠ 2026-09-10 起**档位控件统一为 ★ 星标**(`wishIcon`):原「必看|备选|随缘」三段 seg
//   (`buildWishSeg` + `PRI_BG_ON`)在最后一处调用点(影片资料弹层)也改用 ★ 后**已删** ——
//   需求原话「不要在影片资料中标记必看/备选/随缘,需要和我的行程里面一样,直接在卡片上标记等级」。
//
// 三档配色 = 冷色系(蓝 `--pri-must` / **品红** `--pri-maybe` / 灰蓝 `--pri-wild`):
// ★ 画在甘特卡上,而卡底是红绿灯(绿=已选 / 黄=时间紧张 / 红=冲突),
// 故档位整族搬离红黄绿 —— 与底色正交才能一眼看出「是不是我想看的」。
// ⚠ 备选 2026-09-10 由紫 `#7e22ce` 改品红 `#a21caf`:旧蓝紫只差 48° 色相,小尺寸下分不出(见 style.css)。

import type { Priority } from "./types";
import { el } from "./util";

/** 档位顺序(必看 → 备选 → 随缘),列表排序与 seg 展示同源 */
export const WISH_ORDER: [Priority, string][] = [
  ["must", "必看"],
  ["maybe", "备选"],
  ["wild", "随缘"],
];

export const PRI_LABEL: Record<Priority, string> = { must: "必看", maybe: "备选", wild: "随缘" };

/** 档位排序权重(必看 → 备选 → 随缘)—— 列表排序 / 打包排序 / 抢票顺位**共用**,勿各写一份。
 *  未设档位(null)不在表内:调用方按需回退(如 `WISH_ORDER.length`)。 */
export const PRI_RANK: Record<Priority, number> = { must: 0, maybe: 1, wild: 2 };

/** 档位纯文字色 —— ★ 星标(wishIcon / 甘特卡)与极小字(评分分项说明)共用。
 *  常规「档位」文字场景请用 priTag():以统一微圆角 Tag 呈现,别以纯文本混进标题里。
 *  (`PRI_DOT_BG` 已于 2026-09-10 删除 —— 甘特卡的 7px 色点被 ★ 星标取代,无调用点。) */
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
    "inline-flex items-center rounded-5 px-[6px] py-px text-11 font-bold leading-[1.5] whitespace-nowrap " +
      PRI_TAG[p] +
      (extraCls ? " " + extraCls : ""),
    PRI_LABEL[p]
  );
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
    "fixed z-[250] bg-card border border-line rounded-9 shadow-[var(--shadow-modal)] p-[4px] min-w-[112px] grid gap-px"
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
      `w-full text-left border-0 rounded-6 px-[9px] py-[5px] text-12 font-semibold whitespace-nowrap ${
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

/* ---------- 档位**图标**(影片行右上角 / 行程卡操作组 / 影片资料弹层,2026-09-10 加,见 PLAN-20260910184745 §8) ----------
 * 需求原话:「移除『必看』按钮…改为一个图标(如⭐),hover 时显示文字」——
 * 带文字的档位徽章 + ⓘ + ✕ 三枚控件挤在片名行里,把片名挤成 0 宽、视觉噪声也大。
 * 现在常态只有**一枚星标**:★ = 已定档(按档位着色)/ ☆ = 未设;文字只走 hover 提示
 * (`data-tip`,与全站 tooltip 同源);点击仍弹**同一个** 必看 / 备选 / 随缘 / 清除 菜单。
 * ⚠ 影片资料弹层也用它(`size: "lg"`)—— 三段 seg 的最后一处调用点已于 2026-09-10 换成它。 */

export interface WishIconOpts {
  /** 当前档位;null / undefined = 未设 */
  cur: Priority | null | undefined;
  /** 选中某档 / 清除档位(null) */
  onPick: (next: Priority | null) => void;
  /** title 前缀(如「我的选片 · 」) */
  tipPrefix?: string;
  /** 稳定锚点(菜单回关判定用),一般传影片 key */
  anchor?: string;
  /** 尺寸:`md`(默认,20px 盒 / 13px 星 —— 卡片、行程行)/ `lg`(26px 盒 / 18px 星 —— 影片资料弹层:
   *  弹层里没有卡片底衬托,小星标会显得像装饰,放大会更像一个可点的档位控件) */
  size?: "md" | "lg";
}

/** 档位星标 —— 图标化入口,与 wishBadge() 共用同一个弹出菜单(openWishMenu)。 */
export function wishIcon(o: WishIconOpts): HTMLElement {
  const cur = o.cur ?? null;
  // ⚠ 两档尺寸都写成**完整字面量**(Tailwind v4 只生成源码里出现的类,勿拼 `w-[${n}px]`)
  const box =
    o.size === "lg"
      ? "w-[26px] h-[26px] rounded-6 text-18"
      : "w-[20px] h-[20px] rounded-5 text-13";
  const b = el(
    "button",
    `shrink-0 border-0 bg-transparent p-0 ${box} inline-flex items-center justify-center ` +
      "leading-none transition-[color,background-color] duration-[120ms] " +
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
