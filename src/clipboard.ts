// 复制纯文本到剪贴板 —— 分享文案(`share.ts`)与后续文本出口共用。
//
// 两级降级:
//   ① `navigator.clipboard.writeText` —— 需要**安全上下文**(https / localhost);
//   ② `document.execCommand("copy")` —— 非 https 预览、iOS 旧版、以及 clipboard 权限被拒时的兜底。
// 返回是否成功,调用方据此给 toast(失败文案要引导用户手动选择复制,不能静默什么都不做)。

/** 复制纯文本;返回是否成功。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* clipboard 权限拒绝 / 非安全上下文时降级 execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
