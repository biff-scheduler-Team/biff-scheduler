// 表单行骨架(标签 + 控件同行、提示另起一行)—— 设置弹层 / AI 配置表单共用同一**结构**。
// 视觉规格(字号 / 间距)按上下文传参:两处密度刻意不同,但 DOM 骨架只有一份。
import { el } from "./util";

export interface FieldBoxOpts {
  /** 默认 `label`(点标题即聚焦输入框);**内含 button 的控件必须传 `"div"`** ——
   *  否则点标题会冒泡到 label 内首个 button,表现为「点文字误选了选项」。 */
  tag?: "label" | "div";
  boxCls?: string;
  rowCls?: string;
  labelCls?: string;
  hintCls?: string;
}

/** 返回 `box`(整块)与 `row`(标签 / 控件同行)—— 控件由调用方 append 进 `row`。 */
export function fieldBox(label: string, hint: string, o: FieldBoxOpts = {}): { box: HTMLElement; row: HTMLElement } {
  const box = el(o.tag ?? "label", o.boxCls ?? "grid gap-1");
  const row = el("div", o.rowCls ?? "flex items-center gap-[10px] flex-wrap");
  row.appendChild(el("span", o.labelCls ?? "font-semibold text-13 shrink-0", label));
  box.append(row, el("div", o.hintCls ?? "text-muted text-12", hint));
  return { box, row };
}

/** 数字输入框(统一宽度 / 居中数字 / focus 红描边)—— 设置项与映后时长小弹层共用。 */
export function numInput(value: string, max: number): HTMLInputElement {
  const inp = el(
    "input",
    "w-[76px] text-center tabular-nums border border-line rounded-8 px-2 py-[5px] text-13 " +
      "focus:border-biff focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_30%,var(--color-card))]"
  ) as HTMLInputElement;
  inp.type = "number";
  inp.min = "0";
  inp.max = String(max);
  inp.value = value;
  return inp;
}
