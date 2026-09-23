/**
 * 管理端白名单（2026-09-23，PLAN-20260923140943）。
 *
 * **为什么是「写进代码的 subject 白名单」**：
 *   · 本项目的部署链路是 `git push main`，而 `apps/api` 所在的那个 Cloudflare 账号**不在使用者
 *     手里** —— `wrangler secret put` 与环境变量都没有可用的操作入口（详见 PLAN-20260923124402）；
 *   · 白名单校验的是**已登录会话的身份**（`session.row.subject`），它**不是凭据**：
 *     别人知道这个 id 也伪造不出这个账号的会话。所以把它写进仓库不构成越权入口。
 *
 * ⚠ 代价：换管理员要改代码 + 重新部署；要多管理员就往数组里加。
 * ⚠ 别把这里扩成「角色体系」——IFFDAY 的 profile 契约里没有角色字段，本服务无从判断，
 *   真要按角色收口得先改上游契约（见 PLAN 的「不做」）。
 */

/** 管理员账号 subject 白名单。 */
export const ADMIN_SUBJECTS: readonly string[] = ["user_01M2EVF3GTTJ6JC9NTM8NXYNHY"];

/** 这个 subject 是不是管理员。用 `includes` 而不是 Set：n 极小，且顺序无关紧要。 */
export function isAdminSubject(subject: string): boolean {
  return ADMIN_SUBJECTS.includes(subject);
}
