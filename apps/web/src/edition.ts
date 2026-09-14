/**
 * 当前届次 —— 所有服务端 `edition` 参数的**唯一来源**。
 *
 * 账号同步的文档键(`festival_document.edition`)、「想看人数」、「同场观影人数」都用它。
 * 以前只写在 `want-counts.ts` 里;新增同场人数时若再抄一份就会漂移,故提到这里。
 */

export const EDITION = "biff-2026";
