/** 本地写入落盘后通知账号同步；认证数据不占用 biff.* 命名空间。 */
export function writeWorkspaceItem(key: string, value: string) {
  localStorage.setItem(key, value);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("iffday:workspace-change"));
}
export function removeWorkspaceItem(key: string) {
  localStorage.removeItem(key);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("iffday:workspace-change"));
}
