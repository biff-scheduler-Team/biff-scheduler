/** Notify account sync after durable local writes; no authentication data uses the biff.* namespace. */
export function writeWorkspaceItem(key: string, value: string) {
  localStorage.setItem(key, value);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("iffday:workspace-change"));
}
export function removeWorkspaceItem(key: string) {
  localStorage.removeItem(key);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("iffday:workspace-change"));
}
