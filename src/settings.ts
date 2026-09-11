// 设置弹层 + GV 映后谈单场时长小弹层。
// 从 `main.ts` 拆出(2026-09-10,PLAN-20260910232833):与「装配 / 事件委托」解耦。
// 依赖 `cat` 的部分(映后时长小弹层要查场次)以参数注入,避免反向依赖 main。

import type { Catalog } from "./types";
import { el } from "./util";
import { fieldBox, numInput } from "./form";
import { BTN_MINI, BTN_PRIMARY, BTN_PRIMARY_LG } from "./ui";
import { clearAllPicks, clearScreeningSlots, gvTalkMinOv, setGvTalkMin, setSettings, store } from "./state";
import { closeModal, openModal } from "./modal";
import { toast } from "./toast";
import { aiReady, clearAiCfg, loadAiCfg, maskKey } from "./ai";

/* ---------------- 设置 ----------------
 *  排版口径(2026-09-10 优化):① 标题 + 控件同行**流式左对齐**(控件紧贴标题,标签长短不一也不会
 *  散成右侧一列);② 单位(分钟)移到**框外**做后缀,标题里不再带括号;③ 说明另起一行 12px muted、
 *  行高 1.6;④ 字段之间 14px,分组之间浅灰分割线 —— 一整片文字被切成两块,密度显著下降。 */

/** 设置项骨架:标题 + 控件同一行(左对齐流式),可选单位后缀,说明另起一行小字。
 *  ⚠ `tag` 默认 `label`(点标题即聚焦输入框);**内含 button 的控件(分段选择器)必须传 `"div"`** ——
 *  否则点标题会冒泡到 label 内首个 button,表现为「点文字误选了选项」。 */
function settingsField(
  label: string,
  hint: string,
  control: HTMLElement,
  unit = "",
  tag: "label" | "div" = "label"
): HTMLElement {
  const { box, row } = fieldBox(label, hint, {
    tag,
    boxCls: "flex flex-col gap-[3px]",
    rowCls: "flex items-center gap-[8px]",
    labelCls: "font-semibold text-14 whitespace-nowrap",
    hintCls: "text-muted text-12 leading-[1.6]",
  });
  row.appendChild(control);
  if (unit) row.appendChild(el("span", "text-13 text-ink-2", unit));
  return box;
}

/** iOS 风分段选择器:低饱和灰轨道 + 白色滑块(选中),替代旧「品牌红实底白字」胶囊 ——
 *  设置项里的次要开关不该比「保存设置」这个主按钮更抢眼。两段互斥,点击即切换;
 *  类名口径收口在 cls(),初渲与后续重绘共用一份。 */
function segmented<T extends string>(
  opts: { value: T; label: string }[],
  cur: T,
  onPick: (v: T) => void
): HTMLElement {
  const cls = (on: boolean): string =>
    "border-0 rounded-6 px-[10px] py-[4px] text-13 font-semibold whitespace-nowrap " +
    "transition-[background-color,color,box-shadow] duration-[120ms] " +
    (on ? "bg-card text-ink shadow-[var(--shadow-card)]" : "bg-transparent text-muted hover:text-ink");
  const track = el("div", "inline-flex items-center gap-[2px] p-[2px] rounded-8 bg-raised");
  const btns = new Map<T, HTMLElement>();
  const set = (v: T): void => {
    btns.forEach((b, k) => (b.className = cls(k === v)));
  };
  for (const o of opts) {
    const b = el("button", cls(o.value === cur), o.label);
    b.type = "button";
    b.addEventListener("click", () => {
      onPick(o.value);
      set(o.value);
    });
    btns.set(o.value, b);
    track.appendChild(b);
  }
  return track;
}

export function openSettings(): void {
  const body = el("div", "flex flex-col");

  // ---- 分组 1:导出 / 转场 ----
  const alarm = numInput(String(store.settings.alarmMin), 180);
  const f1 = settingsField(
    "提醒提前量",
    "导出 .ics 日历时的闹钟提醒，建议 30 - 60 分钟。",
    alarm,
    "分钟"
  );

  const transit = numInput(String(store.settings.transitMin), 120);
  const f2 = settingsField(
    "跨场馆转场缓冲",
    "仅用于判定跨影院场次的冲突，同一影院不受影响（默认 0 为仅判定时间重叠）。",
    transit,
    "分钟"
  );

  const group1 = el("div", "flex flex-col gap-[14px]");
  group1.append(f1, f2);

  // ---- 分组 2:GV 映后谈(浅灰分割线分组,不另加小标题 —— 标签已自解释,少一层文字) ----
  let gvDef = store.settings.gvTalkOn;
  const seg = segmented(
    [
      { value: "on", label: "参加 (含映后)" },
      { value: "off", label: "不参加 (仅正片)" },
    ],
    gvDef ? "on" : "off",
    (v) => {
      gvDef = v === "on";
    }
  );
  const f3 = settingsField(
    "GV 场默认映后谈",
    "新增 GV 场次时默认选中的状态（后续可在具体行程中单独切换）。",
    seg,
    "",
    "div"
  );

  // f4:GV 映后谈时长(全局默认)—— 改这里 = 谈段长度 / 有效结束 / 转场 / 冲突 / .ics 全链路跟着变
  const talkMin = numInput(String(store.settings.gvTalkMin), 240);
  const f4 = settingsField(
    "GV 映后谈默认时长",
    "官方排期包含 25 分钟映后谈，设为 0 则不拆分映后段（可逐场覆写）。",
    talkMin,
    "分钟"
  );

  const group2 = el("div", "flex flex-col gap-[14px] mt-[16px] pt-[16px] border-t border-line-soft");
  group2.append(f3, f4);

  // ---- 分组 3:AI 排片 Key(只读状态 + 清除)----
  //  填写 / 更换的入口收在「影片库 ▸ 智能排片」:那里有隐私说明与自定义偏好同屏,
  //  设置里不放输入框 —— 避免误触,也让「Key 只在本机」的说明紧贴使用场景。
  const aiState = el("span", "text-13 font-semibold");
  const aiClear = el("button", BTN_MINI, "清除 Key");
  aiClear.dataset.ai = "settings-clear";
  aiState.dataset.ai = "settings-state";
  const paintAi = (): void => {
    const c = loadAiCfg();
    if (aiReady(c)) {
      aiState.className = "text-13 font-semibold text-ok";
      aiState.textContent = `已配置 · ${c.model} · ${maskKey(c.key)}`;
      aiClear.classList.remove("is-hidden");
    } else {
      aiState.className = "text-13 font-semibold text-muted";
      aiState.textContent = "未配置";
      aiClear.classList.add("is-hidden");
    }
  };
  aiClear.addEventListener("click", () => {
    if (!window.confirm("清除本机保存的 AI 排片 API Key?(其它设置与选片不受影响)")) return;
    clearAiCfg();
    paintAi();
    toast("已清除本机保存的 API Key");
  });
  paintAi();
  const aiCtl = el("div", "flex items-center gap-[8px] flex-wrap");
  aiCtl.append(aiState, aiClear);
  const f5 = settingsField(
    "AI 排片 · 模型 API Key",
    "只保存在本机浏览器（localStorage），不上传本站服务器、也不进任何本站请求。填写 / 更换请到「影片库 ▸ 智能排片」。",
    aiCtl,
    "",
    "div"
  );
  const group3 = el("div", "flex flex-col gap-[14px] mt-[16px] pt-[16px] border-t border-line-soft");
  group3.append(f5);

  // ---- 底部主操作:全弹层唯一的亮色按钮(右对齐)----
  const apply = el("button", BTN_PRIMARY_LG, "保存设置");
  apply.addEventListener("click", () => {
    setSettings({
      alarmMin: clampNum(alarm.value, 45),
      transitMin: clampNum(transit.value, 0),
      gvTalkOn: gvDef,
      gvTalkMin: Math.max(0, Math.round(clampNum(talkMin.value, 25))),
    });
    closeModal();
    toast("设置已保存");
  });
  const actions = el("div", "flex justify-end mt-[18px]");
  actions.appendChild(apply);

  // ---- 危险操作:降级为无边框/无底色的灰色文字按钮,并挪到弹窗最底部单独区域,
  //      与主按钮之间再隔一条分割线 —— 视觉权重拉低 + 误触路径物理隔开 ----
  const danger = el(
    "button",
    "border-0 bg-transparent p-0 text-12 text-muted underline-offset-2 hover:text-conf hover:underline",
    "清空全部已排场次(A+B)"
  );
  danger.dataset.tip = "只清场次 —— 「我的选片」的选片意向(档位)保留,清完仍可一键智能排片";
  danger.addEventListener("click", () => {
    if (window.confirm("确定清空 A/B 两个方案的「全部已排场次」?选片意向(必看/备选/随缘)会保留。")) {
      clearScreeningSlots();
      closeModal();
      toast("已清空全部已排场次(选片意向保留)");
    }
  });
  // 「清空全部」= 连选片意向一起清(2026-09-10,PLAN-20260910235630)。
  // 片单只存本机 → 清完**刷新 / 部署都不会再回来**(旧版会从 D1 同步回来,故用户只能反复手清)。
  const dangerAll = el(
    "button",
    "border-0 bg-transparent p-0 text-12 text-muted underline-offset-2 hover:text-conf hover:underline",
    "清空全部(选片 + 排片)"
  );
  dangerAll.dataset.tip = "把「我的选片」与「我的行程」一起清空 —— 档位 / 备注 / 已排场次全部删除(只影响本机)";
  dangerAll.addEventListener("click", () => {
    if (window.confirm("确定清空全部?「我的选片」的档位、备注与 A/B 已排场次会一起删除,且只存本机、无法从云端恢复。")) {
      clearAllPicks();
      closeModal();
      toast("已清空全部选片与排片");
    }
  });
  const dangerZone = el("div", "flex flex-wrap gap-x-[16px] gap-y-[8px] mt-[14px] pt-[12px] border-t border-line-soft");
  dangerZone.append(danger, dangerAll);

  body.append(group1, group2, group3, actions, dangerZone);

  openModal("设置", body);
}

/** GV 映后谈单场时长覆写小弹层:留空 / 点「跟随默认」= 清除覆写(回到跟随全局默认)。
 *  只有 is_gv 场次有入口(非 GV 无谈段);改完走 state 的 notify → renderAll 重绘网格 / 行程。
 *  ⚠ 需要 `cat` 查场次 —— 由调用方(main)注入,本模块不持有全局数据。 */
export function openTalkMinModal(code: string, cat: Catalog): void {
  const s = cat.byCode.get(code);
  if (!s) return;
  const def = store.settings.gvTalkMin;
  const cur = gvTalkMinOv.get(code);
  const body = el("div", "grid gap-3");

  const inp = numInput(cur == null ? "" : String(cur), 240);
  inp.placeholder = String(def);
  const f = settingsField(
    `本场映后谈时长 · ${code}`,
    `留空 = 跟随全局默认 ${def}′;仅本场生效（其它 GV 场不动），设 0 则不拆映后段。`,
    inp,
    "分钟"
  );
  body.appendChild(f);

  // 底部主操作:与设置弹层同一语言 —— 次要操作在左、主按钮贴右下角(全站唯一亮色按钮的落位口径)
  const actions = el("div", "flex justify-end gap-[10px] mt-1");
  const ok = el("button", BTN_PRIMARY, "保存");
  const follow = el(
    "button",
    "border border-line rounded-6 px-[12px] py-[6px] text-13 font-bold bg-card text-ink hover:border-biff",
    `跟随默认(${def}′)`
  );
  const apply = (min: number | null): void => {
    setGvTalkMin(code, min);
    closeModal();
    toast(min == null ? `已恢复跟随全局默认(${def}′)` : `本场映后谈已设为 ${min}′`);
  };
  ok.addEventListener("click", () => {
    const raw = inp.value.trim();
    apply(raw === "" ? null : Math.max(0, Math.round(clampNum(raw, def))));
  });
  follow.addEventListener("click", () => apply(null));
  actions.append(follow, ok);
  body.appendChild(actions);

  openModal("映后谈时长", body);
}

function clampNum(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
