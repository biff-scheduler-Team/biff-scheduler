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
    b.title = `${o.tipPrefix ?? ""}标为「${label}」${on ? "(再点取消打标)" : " — 供「智能排片」生成行程"}`;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation(); // 三选常嵌在可点容器内(影片库行 / 甘特卡),避免顺带触发展开或选中
      o.onPick(on ? null : p);
    });
    seg.appendChild(b);
  });
  return seg;
}
