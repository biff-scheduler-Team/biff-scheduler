import { parseLoginFailure, type LoginFailureCode } from "@biff/contracts/account";

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
 * 「失败细节」（`account_error=<步骤码>:<细节>` 里冒号后的那一段）→ 人话。
 *
 * 服务端只回**白名单化**的值（`loginFailureDetailSchema`），所以这里没登记过的也可以直接显示 ——
 * 它最多是一串小写字母，不会带用户数据。`invalid_grant` / `network_timeout` 这一对就是
 * 「上游明确拒绝」与「我们等它等到超时」的分界线（见 PLAN-20260916220942）。
 */
const DETAIL_REASONS: Record<string, string> = {
  invalid_grant: "授权码已经被用过或已过期",
  invalid_client: "客户端凭据不匹配",
  invalid_target: "账号系统不接受我们要的那个资源",
  invalid_scope: "申请的权限不被接受",
  invalid_request: "请求本身不合账号系统的要求",
  unauthorized_client: "这个客户端不被允许用这种方式登录",
  server_error: "账号系统内部出错",
  temporarily_unavailable: "账号系统暂时不可用",
  network_timeout: "我们等上游等到超时",
  network_aborted: "这次上游调用被中断",
  network_error: "连不上账号系统",
  unexpected_response: "账号系统的应答不成形",
  unexpected_error: "出现了未预期的错误",
};

/**
 * 未知码**必须把原始码留在文案里** —— 旧实现（`account.ts` 只判断参数在不在）把码整个丢掉，
 * 于是「登录未完成」这句提示在生产上什么也说明不了。留着码，用户就能直接发给我们。
 */
export function loginFailureReason(value: string | null | undefined): string {
  const { code, detail } = parseLoginFailure(value);
  if (!code) return "登录没有完成。请重试。";
  const base =
    LOGIN_FAILURE_REASONS[code as LoginFailureCode] ??
    LEGACY_REASONS[code] ??
    `登录没有完成（${code}）。请把括号里的内容发给我们。`;
  if (!detail) return base;
  return `${base}（上游原因：${DETAIL_REASONS[detail] ?? detail}）`;
}

/**
 * `account_ms` = **失败那一步自己**的耗时（服务端只记这一步，不记整轮）。
 *
 * 它是「是不是超时太短」的直接判据：配上 `network_timeout` 就是撞上了我们的上限；
 * 配上 `invalid_grant` 说明是上游明确拒绝，跟超时无关。
 */
export function loginFailureElapsed(value: string | null | undefined): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return `失败那一步耗时 ${(ms / 1000).toFixed(1)} 秒。`;
}

/** toast / 面板用的整句：带上服务端分诊出来的原因（含上游细节与这一步的耗时）。 */
export function loginFailureMessage(
  value: string | null | undefined,
  elapsed?: string | null,
): string {
  return `登录未完成，本机排片没有改动。原因：${loginFailureReason(value)}${loginFailureElapsed(elapsed)}`;
}
