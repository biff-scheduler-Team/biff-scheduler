/**
 * Legacy 薄账号桥：复用 React 侧 account-sync 核心（无 React / 无 Spectrum）。
 * 同域 cookie Path=/ + 共享 biff.* LS；资料编辑仍去新版。
 */
import {
  accountState,
  initAccountSync,
  onAccountChange,
  signOutAccount,
  syncAccount,
} from "../../src/account-sync";
import { toast } from "./toast";

const statusLabels: Record<string, string> = {
  checking: "正在连接账号…",
  guest: "数据保存在这台设备",
  offline: "离线，修改保存在本机",
  syncing: "正在同步…",
  synced: "已同步",
  pending: "有待同步数据",
  conflict: "有修改需要确认",
  error: "暂未同步",
};

function updateHeader() {
  const btn = document.getElementById("account-btn");
  if (btn) {
    const name = accountState.account?.profile.displayName;
    btn.textContent = name ?? "登录 IFFDAY";
    btn.setAttribute("aria-label", name ? `账号：${name}` : "登录 IFFDAY");
  }
  const status = document.getElementById("account-sync-status");
  if (status) status.textContent = statusLabels[accountState.status] ?? "";
}

export async function initLegacyAccount(onWorkspaceChanged: () => void) {
  const btn = document.getElementById("account-btn");
  const status = document.getElementById("account-sync-status");
  if (!btn || !status) return;

  onAccountChange(updateHeader);
  updateHeader();

  btn.addEventListener("click", () => {
    if (!accountState.account || !accountState.authenticated) {
      window.location.assign("/api/auth/login");
      return;
    }
    const leave = confirm(
      `已登录：${accountState.account.profile.displayName}\n\n确定退出账号？未同步修改会留在本机缓存。\n（资料编辑请用新版界面）`,
    );
    if (!leave) return;
    void (async () => {
      try {
        await signOutAccount();
        toast("已退出账号");
        updateHeader();
      } catch {
        toast("暂时无法退出，请检查网络后重试");
      }
    })();
  });

  try {
    await initAccountSync(onWorkspaceChanged);
  } catch {
    accountState.status = "error";
    accountState.message = "无法读取本机账号缓存";
    updateHeader();
  }

  const url = new URL(location.href);
  if (url.searchParams.has("account") || url.searchParams.has("account_error")) {
    const failed = url.searchParams.has("account_error");
    url.searchParams.delete("account");
    url.searchParams.delete("account_error");
    history.replaceState(null, "", url);
    if (failed) toast("登录未完成，本机排片没有改动");
    else {
      toast("已连接 IFFDAY 账号");
      void syncAccount();
    }
  }
}
