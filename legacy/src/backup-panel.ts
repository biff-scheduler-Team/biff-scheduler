// 「导入」弹层 —— 备份 / 迁移 + .ics 排片导入的 **DOM 侧**。
//
// 与 `backup.ts` 的分工:那个是纯逻辑(快照 / 还原 / 解析 / .ics 反解,可在 node 单测直接导入),
// 这个是弹层(选文件 / 粘贴 / 状态提示 / 覆盖确认),必须 import modal / ui。
// 之所以拆开:`modal.ts` 在 **import 期**就挂 `document` 的 keydown 监听 ——
// 纯逻辑与它同处一个模块,会让单测连 `import` 都跑不起来(node 环境没有 document)。
//
// ★ 两条入口共用一个弹层(2026-09-12):**按内容自动识别类型** ——
//   带 `BEGIN:VCALENDAR` → .ics 排片导入(反解场次 code);否则 → 备份 JSON(整体替换本机全部 `biff.*` 键)。
//   .ics 只能恢复**场次**,恢复不了备注 / 顺位 / 已保存方案 / 设置(见 `backup.ts` 文件头);
//   故它多一个「合并 / 替换」二选一,默认**合并** —— 备份导入是硬替换,没有这个选择。

import { el } from "./util";
import { BTN_MINI, BTN_PRIMARY_LG } from "./ui";
import { closeModal, openModal } from "./modal";
import { applyBackup, parseBackupText, parseIcsCodes } from "./backup";

/** 超过这个长度的内容不回填到文本框 —— 大 JSON 塞进 textarea 会卡住输入框,
 *  此时仅靠文件读取的结果即可(用户要看内容请直接打开文件)。 */
const BACKFILL_LIMIT = 50_000;

/** .ics 导入需要的宿主能力(`backup-panel` 不持有 cat / store,由 `main.ts` 注入) */
export interface IcsImport {
  /** 该 code 是否存在于当前排期(换版残留的 code 会被过滤掉) */
  isValidCode: (code: string) => boolean;
  /** 执行导入:`merge` = 并入(默认);`replace` = 先清空现有场次 */
  apply: (codes: string[], mode: "merge" | "replace") => void;
}

/** 待导入的内容 —— 二选一(备份 JSON / .ics 排片) */
type Pending = { kind: "backup"; data: Record<string, string> } | { kind: "ics"; codes: string[] };

/** 「导入」弹层:选文件 / 粘贴文本两条路,自动识别备份 JSON 与 .ics 排片。
 *  为什么要两条:手机上的文件选择器不一定好使(备份文件常是先传到微信再打开),
 *  从聊天里复制一段文本粘进来同样能恢复。 */
export function openImportBackupModal(ics?: IcsImport): void {
  const body = el("div", "grid gap-[12px]");

  body.appendChild(
    el(
      "div",
      "text-12 text-muted leading-[1.6]",
      "片单只存在本机(按域名隔离),换域名 / 换设备不会自动跟过去 —— " +
        "在旧域名用顶栏「导出 · 分享 → 导出数据备份」存一份 JSON,再到这里导入即可。" +
        "导入会整体覆盖本机现有的选片 / 排片 / 顺位 / 设置,建议先导出留底。" +
        "也可以选一份别人发来的 .ics(只恢复场次,不含备注 / 顺位 / 方案)。"
    )
  );

  // ① 选文件(两种类型都收 —— 认类型的是内容,不是扩展名)
  const file = el("input") as HTMLInputElement;
  file.type = "file";
  file.accept = ".json,application/json,.ics,text/calendar";
  file.className = "hidden";
  const pick = el("button", BTN_MINI, "选择备份 / .ics 文件…");
  pick.type = "button";
  const fileName = el("span", "text-12 text-muted truncate", "未选择文件");
  const fileRow = el("div", "flex items-center gap-[8px] min-w-0");
  fileRow.append(pick, fileName, file);

  // ② 或粘贴
  const ta = el("textarea") as HTMLTextAreaElement;
  ta.className =
    "w-full h-[120px] border border-line rounded-8 p-[8px] text-12 resize-y " +
    "bg-card text-ink focus:border-biff focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_30%,var(--color-card))]";
  ta.placeholder = "或把备份 JSON / .ics 文本粘贴到这里";

  const status = el("div", "text-12 leading-[1.6]");

  // ③ .ics 专属:合并 / 替换(识别到 .ics 才显示;默认合并)
  const icsBox = el("div", "grid gap-[6px] rounded-8 border border-line bg-[var(--bg-hover-soft)] p-[9px] is-hidden");
  icsBox.appendChild(el("div", "text-12 font-semibold text-ink", "这份 .ics 是排片场次 —— 怎么导入?"));
  const segRow = el("div", "flex items-center gap-[6px] flex-wrap");
  let icsMode: "merge" | "replace" = "merge";
  const segBtns: { mode: "merge" | "replace"; btn: HTMLElement }[] = [];
  const paintSeg = (): void => {
    for (const { mode, btn } of segBtns) {
      btn.className =
        "border rounded-6 px-[9px] py-[3px] text-12 font-bold whitespace-nowrap " +
        (mode === icsMode
          ? "border-biff bg-biff-soft text-biff-ink"
          : "border-line bg-card text-ink hover:border-line-strong");
    }
  };
  const addSeg = (mode: "merge" | "replace", label: string, tip: string): void => {
    const btn = el("button", "", label);
    btn.type = "button";
    btn.dataset.tip = tip;
    btn.addEventListener("click", () => {
      icsMode = mode;
      paintSeg();
    });
    segBtns.push({ mode, btn });
    segRow.appendChild(btn);
  };
  addSeg("merge", "并入现有行程", "把 .ics 里的场次并进本机行程 —— 已在行程里的不重复加(默认)");
  addSeg("replace", "替换现有场次", "先清空本机全部已排场次,再放入 .ics 里的这些场次");
  paintSeg();
  icsBox.appendChild(segRow);

  // 底部主操作(与设置弹层同一语言:次要操作在左、主按钮贴右下角)
  const actions = el("div", "flex justify-end gap-[10px] mt-1");
  const cancel = el("button", BTN_MINI, "取消");
  cancel.type = "button";
  const importBtn = el("button", BTN_PRIMARY_LG, "导入并覆盖本机数据");
  importBtn.type = "button";
  importBtn.disabled = true;
  importBtn.classList.add("disabled:opacity-40", "disabled:cursor-not-allowed");
  actions.append(cancel, importBtn);

  let pending: Pending | null = null;
  const setFail = (error: string): void => {
    pending = null;
    icsBox.classList.add("is-hidden");
    status.className = "text-12 leading-[1.6] text-conf";
    status.textContent = error;
    importBtn.disabled = true;
  };
  const setOk = (p: Pending, msg: string): void => {
    pending = p;
    icsBox.classList.toggle("is-hidden", p.kind !== "ics");
    status.className = "text-12 leading-[1.6] text-ink-2";
    status.textContent = msg;
    importBtn.textContent = p.kind === "ics" ? "导入排片" : "导入并覆盖本机数据";
    importBtn.disabled = false;
  };
  const clearResult = (): void => {
    pending = null;
    icsBox.classList.add("is-hidden");
    status.className = "text-12 leading-[1.6]";
    status.textContent = "";
    importBtn.disabled = true;
  };

  /** 按内容识别类型:`.ics` 走排片导入,其余按备份 JSON 解析 */
  const handleText = (text: string, label: string): void => {
    if (/BEGIN:VCALENDAR/i.test(text)) {
      const r = parseIcsCodes(text);
      if (!r.ok) {
        setFail(r.error);
        return;
      }
      const valid = ics ? r.codes.filter((c) => ics.isValidCode(c)) : r.codes;
      if (valid.length === 0) {
        setFail("这份 .ics 里的场次都不在当前排期里(可能不是本工具导出的)");
        return;
      }
      const dropped = r.codes.length - valid.length;
      setOk(
        { kind: "ics", codes: valid },
        `识别到 ${valid.length} 场排片(${label})` +
          (dropped ? `,另有 ${dropped} 场不在当前排期,已忽略` : "") +
          ",可以导入"
      );
      return;
    }
    const r = parseBackupText(text);
    if (!r.ok) {
      setFail(r.error);
      return;
    }
    setOk({ kind: "backup", data: r.data }, `已识别 ${Object.keys(r.data).length} 项数据(${label}),可以导入`);
  };

  pick.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (!f) return;
    fileName.textContent = f.name;
    void f.text().then((text) => {
      if (text.length <= BACKFILL_LIMIT) ta.value = text;
      handleText(text, f.name);
    });
  });

  ta.addEventListener("input", () => {
    if (!ta.value.trim()) {
      clearResult();
      return;
    }
    handleText(ta.value, "粘贴内容");
  });

  cancel.addEventListener("click", () => closeModal());
  importBtn.addEventListener("click", () => {
    const p = pending;
    if (!p) return;
    if (p.kind === "backup") {
      const yes = window.confirm(
        "导入会整体覆盖本机当前的选片 / 排片 / 抢票顺位 / 设置(不可撤销)。\n" +
          "建议先用「导出数据备份」留一份底。确定继续?"
      );
      if (yes) applyBackup(p.data);
      return;
    }
    if (!ics) return;
    const n = p.codes.length;
    const yes = window.confirm(
      icsMode === "merge"
        ? `把 ${n} 场排片并入本机行程(已在行程里的不重复加)?\n备注 / 抢票顺位 / 已保存方案不受影响。`
        : `会先清空本机全部已排场次,再放入这 ${n} 场?\n备注与已保存方案保留;被清掉场次的抢票顺位会一并清除。`
    );
    if (!yes) return;
    ics.apply(p.codes, icsMode);
    closeModal();
  });

  // 顺序:说明 → 选文件 → 粘贴 → 识别结果 → (.ics 时)合并/替换 → 操作
  body.append(fileRow, ta, status, icsBox, actions);
  openModal("导入数据备份", body);
}
