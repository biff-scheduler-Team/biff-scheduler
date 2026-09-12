import { el } from "./util";
import { openModal, closeModal } from "./modal";
import { toast } from "./toast";
import { workspaceCounts } from "./sync-data";
import {
  accountState,
  api,
  ApiFailure,
  onAccountChange,
  initAccountSync,
  syncAccount,
  resolveSyncConflicts,
  conflictSource,
  refreshAccountProfile,
  signOutAccount,
  downloadAccountBackup,
} from "./account-sync";

const buttonClass =
  "min-h-[44px] border border-line rounded-6 px-3 py-2 text-14 font-semibold bg-card text-ink hover:opacity-90 disabled:opacity-50";
const primaryClass = `${buttonClass} !bg-biff !text-on-brand !border-biff`;
const inputClass =
  "w-full min-h-[44px] rounded-6 border border-line bg-card px-3 py-2 text-[16px] text-ink focus:border-biff";
const statusLabels = {
  checking: "正在连接账号…",
  guest: "数据保存在这台设备",
  offline: "离线，修改保存在本机",
  syncing: "正在同步…",
  synced: "已同步",
  pending: "有待同步数据",
  conflict: "有修改需要确认",
  error: "暂未同步",
};
let labelForRecord: (key: string) => string = () => "排片数据";
function button(label: string, action: () => void, primary = false) {
  const node = el("button", primary ? primaryClass : buttonClass, label) as HTMLButtonElement;
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function field(label: string, input: HTMLInputElement | HTMLTextAreaElement) {
  const box = el("label", "grid gap-2 text-14 font-semibold");
  box.append(el("span", "", label), input);
  return box;
}
function updateHeader() {
  const target = document.getElementById("account-btn");
  if (!target) return;
  target.textContent = accountState.account?.profile.displayName ?? "登录 IFFDAY";
  target.setAttribute(
    "aria-label",
    accountState.account ? `账号：${accountState.account.profile.displayName}` : "登录 IFFDAY",
  );
  const status = document.getElementById("account-sync-status");
  if (status) status.textContent = statusLabels[accountState.status];
}
export async function initAccount(
  onWorkspaceChanged: () => void,
  describeRecord: (key: string) => string,
) {
  labelForRecord = describeRecord;
  document.getElementById("account-btn")?.addEventListener("click", openAccountPanel);
  onAccountChange(updateHeader);
  updateHeader();
  try {
    await initAccountSync(onWorkspaceChanged);
  } catch {
    accountState.status = "error";
    accountState.message = "无法读取本机账号缓存，请先导出数据备份。";
    updateHeader();
  }
  const url = new URL(location.href);
  const connected = url.searchParams.has("account");
  const failed = url.searchParams.has("account_error");
  if (connected || failed) {
    url.searchParams.delete("account");
    url.searchParams.delete("account_error");
    history.replaceState(null, "", url);
    if (failed) toast("登录未完成，本机排片没有改动。请重试。");
    setTimeout(openAccountPanel, 0);
  }
}
async function jpegAvatar(file: File): Promise<Blob> {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    throw new Error("请选择 10 MB 以内的 JPG、PNG 或 WebP 图片。");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理图片。");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 512, 512);
    const side = Math.min(bitmap.width, bitmap.height);
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      512,
      512,
    );
    for (const quality of [0.84, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      if (blob && blob.size <= 256 * 1024) return blob;
    }
    throw new Error("图片压缩后仍然过大，请换一张图片。");
  } finally {
    bitmap.close();
  }
}
export function openAccountPanel() {
  const body = el("div", "grid gap-5");
  const profile = accountState.account;
  let previewUrl: string | null = null;
  const report = el("p", "text-14 text-muted");
  report.setAttribute("role", "status");
  body.append(report);
  const refreshStatus = () => {
    report.textContent = accountState.message || statusLabels[accountState.status];
  };
  refreshStatus();
  if (!profile || !accountState.authenticated) {
    body.append(
      el(
        "p",
        "text-14 text-muted",
        profile
          ? "重新登录后，可继续同步这个账号在本机保存的排片。"
          : "使用 IFFDAY 账号保存排片，在其他设备继续查看。未登录也可以继续使用本机排片。",
      ),
    );
    body.append(
      button(
        profile ? "重新登录 IFFDAY" : "使用 IFFDAY 登录",
        () => {
          window.location.assign("/api/auth/login");
        },
        true,
      ),
    );
  } else {
    const form = el("form", "grid gap-4") as HTMLFormElement;
    form.append(el("p", "text-14 text-muted", "这里修改的名称、头像和简介用于所有 IFFDAY 应用。"));
    const name = el("input", inputClass) as HTMLInputElement;
    name.value = profile.profile.displayName;
    name.required = true;
    name.maxLength = 80;
    name.setAttribute("autocomplete", "nickname");
    const bio = el("textarea", inputClass) as HTMLTextAreaElement;
    bio.value = profile.profile.bio;
    bio.maxLength = 500;
    bio.rows = 3;
    const avatar = el(
      "img",
      "h-20 w-20 rounded-8 object-cover border border-line",
    ) as HTMLImageElement;
    avatar.alt = "账号头像";
    if (profile.profile.avatarUrl) avatar.src = profile.profile.avatarUrl;
    else avatar.hidden = true;
    const file = el("input", inputClass) as HTMLInputElement;
    file.type = "file";
    file.accept = "image/jpeg,image/png,image/webp";
    const feedback = el("p", "text-14 text-muted");
    feedback.setAttribute("role", "status");
    let selected: Blob | null = null;
    let profileVersion = profile.profile.version;

    const removeAvatar = button("移除头像", () => {
      void (async () => {
        removeAvatar.disabled = true;
        try {
          await api("/api/account/avatar", { method: "DELETE" });
          await refreshAccountProfile();
          avatar.hidden = true;
          feedback.textContent = "头像已移除。";
        } catch {
          feedback.textContent = "头像未能移除，请重试。";
        } finally {
          removeAvatar.disabled = false;
        }
      })();
    });
    removeAvatar.hidden = !profile.profile.avatarUrl;
    const save = button("保存个人资料", () => {}, true);
    save.type = "submit";
    file.addEventListener("change", () => {
      void (async () => {
        const image = file.files?.[0];
        if (!image) return;
        save.disabled = true;
        feedback.textContent = "正在处理图片…";
        try {
          selected = await jpegAvatar(image);
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          previewUrl = URL.createObjectURL(selected);
          avatar.src = previewUrl;
          avatar.hidden = false;
          feedback.textContent = "头像已准备好，保存后会更新到 IFFDAY。";
        } catch (error) {
          selected = null;
          feedback.textContent =
            error instanceof DOMException
              ? "这张图片无法读取，请换一张 JPG、PNG 或 WebP 图片。"
              : error instanceof Error
                ? error.message
                : "无法处理图片。";
        } finally {
          save.disabled = false;
        }
      })();
    });
    form.append(
      avatar,
      field("头像", file),
      removeAvatar,
      field("显示名称", name),
      field("简介", bio),
      el("p", "text-12 text-muted", profile.user.email),
      save,
      feedback,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (save.disabled) return;
      void (async () => {
        save.disabled = true;
        save.textContent = "正在保存…";
        feedback.textContent = "";
        let savedProfile = false;
        let savedAvatar = !selected;
        try {
          const response = await api("/api/account/profile", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              displayName: name.value,
              bio: bio.value,
              expectedVersion: profileVersion,
            }),
          });
          profileVersion = ((await response.json()) as { version: number }).version;
          savedProfile = true;
          if (selected) {
            await api("/api/account/avatar", {
              method: "PUT",
              headers: { "Content-Type": "image/jpeg" },
              body: selected,
            });
            savedAvatar = true;
          }
          await refreshAccountProfile();
          profileVersion = accountState.account!.profile.version;
          selected = null;
          file.value = "";
          feedback.textContent = "IFFDAY 个人资料已更新。";
        } catch (error) {
          feedback.textContent =
            error instanceof ApiFailure && error.status === 409
              ? "资料已在其他地方更新。请重新打开账号面板后再编辑。"
              : savedProfile
                ? savedAvatar
                  ? "资料已保存，暂时无法刷新显示。请稍后重新打开账号面板。"
                  : "名称和简介已保存，头像尚未更新。请重试。"
                : "资料未能保存，请检查连接后重试。";
        } finally {
          save.disabled = false;
          save.textContent = "保存个人资料";
        }
      })();
    });
    body.append(form);
  }
  const sync = el("section", "grid gap-3 border-t border-line pt-4");
  let syncSignature = "";
  function renderSync() {
    const signature = JSON.stringify([
      accountState.conflicts,
      accountState.pendingImport,
      accountState.lastSyncAt,
      accountState.account?.user.id,
    ]);
    if (signature === syncSignature) return;
    syncSignature = signature;
    sync.replaceChildren();
    sync.append(el("h3", "text-16 font-bold", "BIFF 2026 排片同步"));
    if (accountState.conflicts.length) {
      sync.append(
        el(
          "p",
          "text-14 text-muted",
          "同一项数据在两处都有修改。请为每项选择保留的版本，其他修改会自动合并。",
        ),
      );
      const choices: Record<string, "local" | "remote"> = {};
      for (const conflict of accountState.conflicts) {
        const label = el("label", "grid gap-2 text-14");
        label.append(el("span", "font-semibold", labelForRecord(conflict.key)));
        const preview = (raw: string | null) => {
          if (raw === null) return "已删除";
          const value = JSON.parse(raw);
          if (value && typeof value === "object" && "note" in value)
            return `场次：${Object.keys(value.codes ?? {}).join("、") || "尚未选场"}；备注：${value.note || "无"}`;
          if (value && typeof value === "object" && "name" in value)
            return `${value.name}；场次：${Array.isArray(value.codes) ? value.codes.join("、") : "无"}`;
          return JSON.stringify(value).slice(0, 160);
        };
        label.append(
          el("span", "text-12 text-muted break-words", `本机：${preview(conflict.local)}`),
          el(
            "span",
            "text-12 text-muted break-words",
            `${conflictSource()}：${preview(conflict.remote)}`,
          ),
        );
        const select = el("select", inputClass) as HTMLSelectElement;
        select.append(
          new Option(`保留这台设备${conflict.local === null ? "的删除操作" : "的版本"}`, "local"),
          new Option(
            `保留${conflictSource()}${conflict.remote === null ? "的删除操作" : "的版本"}`,
            "remote",
          ),
        );
        choices[conflict.key] = "local";
        select.onchange = () => {
          choices[conflict.key] = select.value === "remote" ? "remote" : "local";
        };
        label.append(select);
        sync.append(label);
      }
      sync.append(button("确认选择并同步", () => void resolveSyncConflicts(choices), true));
    } else if (accountState.pendingImport && accountState.authenticated) {
      const counts = workspaceCounts(accountState.pendingImport);
      sync.append(
        el(
          "p",
          "text-14",
          `正在自动导入 ${counts.films} 部选片、${counts.plans} 个保存方案及排片偏好。原始数据会保留本机备份。`,
        ),
      );
      sync.append(
        button("重试同步", () => void syncAccount()),
      );
    } else if (accountState.account) {
      sync.append(button("立即同步", () => void syncAccount()));
      if (accountState.lastSyncAt)
        sync.append(
          el(
            "p",
            "text-12 text-muted",
            `上次同步：${new Date(accountState.lastSyncAt).toLocaleString()}`,
          ),
        );
    }
    sync.append(button("导出本机数据备份", downloadAccountBackup));
  }
  renderSync();
  body.append(sync);
  if (profile)
    body.append(button("切换账号", () => window.location.assign("/api/auth/login?prompt=login")));
  if (profile)
    body.append(
      button("退出账号", () => {
        void (async () => {
          try {
            await signOutAccount();
            closeModal();
            toast("已退出账号。未同步修改保留在该账号的本机缓存中。");
          } catch {
            report.textContent = "暂时无法退出，请检查网络后重试。";
          }
        })();
      }),
    );
  const center = el("a", "text-14 underline", "前往 IFFDAY 账号中心") as HTMLAnchorElement;
  center.href = "https://account.iff.day/account";
  center.target = "_blank";
  center.rel = "noopener noreferrer";
  body.append(center);
  openModal("IFFDAY 账号", body, "md");
  const unsubscribe = onAccountChange(() => {
    if (!body.isConnected) {
      unsubscribe();
      return;
    }
    refreshStatus();
    renderSync();
  });
  const observer = new MutationObserver(() => {
    if (!body.isConnected) {
      unsubscribe();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      observer.disconnect();
    }
  });
  const root = document.getElementById("modal-root");
  if (root) observer.observe(root, { childList: true, subtree: true });
}
