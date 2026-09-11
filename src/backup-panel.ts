// 「导入备份」弹层 —— 备份 / 迁移的 **DOM 侧**。
//
// 与 `backup.ts` 的分工:那个是纯逻辑(快照 / 还原 / 解析,可在 node 单测直接导入),
// 这个是弹层(选文件 / 粘贴 / 状态提示 / 覆盖确认),必须 import modal / ui。
// 之所以拆开:`modal.ts` 在 **import 期**就挂 `document` 的 keydown 监听 ——
// 纯逻辑与它同处一个模块,会让单测连 `import` 都跑不起来(node 环境没有 document)。

import { el } from "./util";
import { BTN_MINI, BTN_PRIMARY_LG } from "./ui";
import { closeModal, openModal } from "./modal";
import { applyBackup, parseBackupText, type BackupParse } from "./backup";

/** 超过这个长度的备份内容不回填到文本框 —— 大 JSON 塞进 textarea 会卡住输入框,
 *  此时仅靠文件读取的结果即可(用户要看内容请直接打开文件)。 */
const BACKFILL_LIMIT = 50_000;

/** 「导入备份」弹层:选文件 / 粘贴文本两条路。
 *  为什么要两条:手机上的文件选择器不一定好使(备份文件常是先传到微信再打开),
 *  从聊天里复制一段文本粘进来同样能恢复。 */
export function openImportBackupModal(): void {
  const body = el("div", "grid gap-[12px]");

  body.appendChild(
    el(
      "div",
      "text-12 text-muted leading-[1.6]",
      "片单只存在本机(按域名隔离),换域名 / 换设备不会自动跟过去 —— " +
        "在旧域名用顶栏「导出 · 分享 → 导出数据备份」存一份 JSON,再到这里导入即可。" +
        "导入会整体覆盖本机现有的选片 / 排片 / 顺位 / 设置,建议先导出留底。"
    )
  );

  // ① 选文件
  const file = el("input") as HTMLInputElement;
  file.type = "file";
  file.accept = ".json,application/json";
  file.className = "hidden";
  const pick = el("button", BTN_MINI, "选择备份文件…");
  pick.type = "button";
  const fileName = el("span", "text-12 text-muted truncate", "未选择文件");
  const fileRow = el("div", "flex items-center gap-[8px] min-w-0");
  fileRow.append(pick, fileName, file);

  // ② 或粘贴
  const ta = el("textarea") as HTMLTextAreaElement;
  ta.className =
    "w-full h-[120px] border border-line rounded-8 p-[8px] text-12 resize-y " +
    "bg-card text-ink focus:border-biff focus:[outline:2px_solid_color-mix(in_srgb,var(--color-biff)_30%,var(--color-card))]";
  ta.placeholder = "或把备份 JSON 粘贴到这里";

  const status = el("div", "text-12 leading-[1.6]");

  // 底部主操作(与设置弹层同一语言:次要操作在左、主按钮贴右下角)
  const actions = el("div", "flex justify-end gap-[10px] mt-1");
  const cancel = el("button", BTN_MINI, "取消");
  cancel.type = "button";
  const importBtn = el("button", BTN_PRIMARY_LG, "导入并覆盖本机数据");
  importBtn.type = "button";
  importBtn.disabled = true;
  importBtn.classList.add("disabled:opacity-40", "disabled:cursor-not-allowed");
  actions.append(cancel, importBtn);

  let parsed: Record<string, string> | null = null;
  const setResult = (r: BackupParse, label: string): void => {
    if (r.ok) {
      parsed = r.data;
      status.className = "text-12 leading-[1.6] text-ink-2";
      status.textContent = `已识别 ${Object.keys(r.data).length} 项数据(${label}),可以导入`;
      importBtn.disabled = false;
      return;
    }
    parsed = null;
    status.className = "text-12 leading-[1.6] text-conf";
    status.textContent = r.error;
    importBtn.disabled = true;
  };

  pick.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (!f) return;
    fileName.textContent = f.name;
    void f.text().then((text) => {
      if (text.length <= BACKFILL_LIMIT) ta.value = text;
      setResult(parseBackupText(text), f.name);
    });
  });

  ta.addEventListener("input", () => {
    if (!ta.value.trim()) {
      parsed = null;
      status.className = "text-12 leading-[1.6]";
      status.textContent = "";
      importBtn.disabled = true;
      return;
    }
    setResult(parseBackupText(ta.value), "粘贴内容");
  });

  cancel.addEventListener("click", () => closeModal());
  importBtn.addEventListener("click", () => {
    if (!parsed) return;
    const ok = window.confirm(
      "导入会整体覆盖本机当前的选片 / 排片 / 抢票顺位 / 设置(不可撤销)。\n" +
        "建议先用「导出数据备份」留一份底。确定继续?"
    );
    if (ok) applyBackup(parsed);
  });

  body.append(fileRow, ta, status, actions);
  openModal("导入数据备份", body);
}
