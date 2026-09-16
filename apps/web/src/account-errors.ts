import type { LoginFailureCode } from "@biff/contracts/account";

/**
 * 登录失败（`/?account_error=<code>`）的中文原因 —— **文案的唯一来源**。
 *
 * 用 `Record<LoginFailureCode, string>` 而不是普通对象：服务端在契约里新增一个码、这里漏写文案，
 * 会**直接编译不过**。这是「病因必须一直可见」的机械保证，而不是靠人记得同步
 * （见 PLAN-20260916215100）。
 */
export const LOGIN_FAILURE_REASONS: Record<LoginFailureCode, string> = {
  pending_cookie_missing:
    "浏览器没有把这次的登录临时凭证带回来（换过浏览器窗口、禁用过 Cookie，或是在无痕窗口里打开的）。请在同一个窗口重新登录。",
  pending_expired:
    "这次登录已经超时（在账号页面停留超过 10 分钟），或者同一个浏览器先后发起了两次登录。请重新点一次登录，并只保留一个登录页。",
  pending_unreadable: "服务端读不回这次的登录临时记录（多半是密钥变更过）。请重新登录。",
  upstream_unreachable: "IFFDAY 账号系统暂时连不上或返回的配置不符合要求。请稍后重试。",
  authorize_denied: "账号系统在「授权」这一步就拒绝了这个账号（没有同意授权，或该账号不能使用本应用）。",
  state_mismatch:
    "这次登录与开始时的会话对不上，常见于同一个浏览器连开了两次登录。请只保留一个登录页，再重新登录。",
  token_rejected: "账号系统拒绝发放登录凭证。请重新登录；如果反复出现，请把这句话发给我们。",
  id_token_invalid: "登录凭证没有通过校验。请重新登录。",
  subject_invalid: "账号标识的形态与预期不符（账号系统可能改过身份编号的生成方式）。请把这句话发给我们。",
  userinfo_failed: "读取账号资料失败（可能是账号没有返回邮箱）。请稍后重试。",
  session_store_failed: "服务端保存这次登录失败。请稍后重试。",
  pending_store_failed: "服务端无法开始这次登录（写登录临时记录失败）。请稍后重试。",
  authorization: "登录过程中出现了未知错误。请重试；如果反复出现，请把这句话发给我们。",
};

/**
 * 旧版服务端（2026-09-16 之前）只发过 `expired` / `authorization` 两个桶：
 * 老书签、缓存页面、以及没刷新过的标签页还会带着它们。
 */
const LEGACY_REASONS: Record<string, string> = {
  expired: "登录临时凭证已失效（在账号页面停留过久，或重复发起了登录）。请重新登录。",
};

/**
 * 未知码**必须把原始码留在文案里** —— 旧实现（`account.ts` 只判断参数在不在）把码整个丢掉，
 * 于是「登录未完成」这句提示在生产上什么也说明不了。留着码，用户就能直接发给我们。
 */
export function loginFailureReason(code: string | null | undefined): string {
  if (!code) return "登录没有完成。请重试。";
  return (
    LOGIN_FAILURE_REASONS[code as LoginFailureCode] ??
    LEGACY_REASONS[code] ??
    `登录没有完成（${code}）。请把括号里的内容发给我们。`
  );
}

/** toast / 面板用的整句：带上服务端分诊出来的原因。 */
export function loginFailureMessage(code: string | null | undefined): string {
  return `登录未完成，本机排片没有改动。原因：${loginFailureReason(code)}`;
}
