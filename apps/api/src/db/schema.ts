import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 持久化的列名与默认值要与最初的 0001_account.sql 保持兼容。
export const oauthPending = sqliteTable("oauth_pending", {
  cookie_hash: text().primaryKey().notNull(),
  payload: text().notNull(),
  expires_at: integer().notNull(),
}, (table) => [index("oauth_pending_expiry").on(table.expires_at)]);

export const appSession = sqliteTable("app_session", {
  token_hash: text().primaryKey().notNull(),
  subject: text().notNull(),
  payload: text().notNull(),
  expires_at: integer().notNull(),
  token_expires_at: integer().notNull(),
  refresh_until: integer().notNull().default(0),
}, (table) => [
  index("app_session_subject").on(table.subject),
  index("app_session_expiry").on(table.expires_at),
]);

export const festivalDocument = sqliteTable("festival_document", {
  subject: text().notNull(),
  edition: text().notNull(),
  revision: integer().notNull().default(0),
  records: text().notNull().default("{}"),
  last_operation: text(),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.subject, table.edition] }),
  check("festival_document_records_json", sql`json_valid(${table.records})`),
]);

export type SessionRow = typeof appSession.$inferSelect;

// 按账号隔离、跨设备共享；只有一次确认过的导入才会创建这一行。
export const accountImport = sqliteTable("account_import", {
  subject: text().primaryKey().notNull(),
  operation_id: text().notNull(),
  imported_at: integer().notNull(),
});

/** 每个贡献者在每部片上的「想看」权重；聚合表可由这些行重算。 */
export const filmWantContribution = sqliteTable("film_want_contribution", {
  edition: text().notNull(),
  film_key: text().notNull(),
  contributor: text().notNull(),
  weight: text().notNull(), // store as text for exact "1" / "0.75" without float drift in SQLite
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.film_key, table.contributor] }),
  index("film_want_contribution_contributor").on(table.edition, table.contributor),
]);

/** 按片聚合的 weight_sum，读是 O(片数)；展示时按 Math.round 取整。 */
export const filmWantStat = sqliteTable("film_want_stat", {
  edition: text().notNull(),
  film_key: text().notNull(),
  weight_sum: text().notNull().default("0"),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.film_key] }),
]);

/** 建议反馈留言：独立表，不复用 festival_document。 */
export const feedbackPost = sqliteTable("feedback_post", {
  id: text().primaryKey().notNull(),
  subject: text().notNull(),
  display_name: text().notNull(),
  body: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  index("feedback_post_created").on(table.created_at),
  index("feedback_post_subject").on(table.subject),
]);

/** 每用户每帖每种 emoji 至多一条；再点即取消。 */
export const feedbackReaction = sqliteTable("feedback_reaction", {
  post_id: text().notNull(),
  subject: text().notNull(),
  emoji: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.post_id, table.subject, table.emoji] }),
  index("feedback_reaction_post").on(table.post_id),
]);

/** 同场观影人数：每位贡献者「行程里有哪些场次」，用于重算 screening_attendance_stat。 */
export const screeningAttendanceContribution = sqliteTable("screening_attendance_contribution", {
  edition: text().notNull(),
  code: text().notNull(),
  contributor: text().notNull(),
  weight: text().notNull(), // 同 film_want_contribution：以文本存 "1" / "0.75"，避免 SQLite 浮点漂移
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.code, table.contributor] }),
  index("screening_attendance_contribution_contributor").on(table.edition, table.contributor),
]);

/** 每场次聚合权重（展示时 Math.round）；O(场次数) 读，供「同场 N 人」徽章。 */
export const screeningAttendanceStat = sqliteTable("screening_attendance_stat", {
  edition: text().notNull(),
  code: text().notNull(),
  weight_sum: text().notNull().default("0"),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.code] }),
]);

/** 场次讨论帖：一场一条流，分类由 `@biff/contracts/screening` 白名单约束。独立表，不复用 festival_document。 */
export const screeningPost = sqliteTable("screening_post", {
  id: text().primaryKey().notNull(),
  edition: text().notNull(),
  code: text().notNull(),
  subject: text().notNull(),
  display_name: text().notNull(),
  category: text().notNull(),
  body: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  index("screening_post_code_created").on(table.code, table.created_at),
  // 全站讨论墙（`code = null`）只按 edition 过滤 + 按 created_at 排序，
  // 前导列是 code 的那条索引服务不了它（落到全表扫 + 文件排序）——
  // 2026-09-23，PLAN-20260923111748，B2。
  index("screening_post_edition_created").on(table.edition, table.created_at),
  index("screening_post_subject").on(table.subject),
]);

/** 每用户每帖每种 emoji 至多一条；再点即取消。 */
export const screeningReaction = sqliteTable("screening_reaction", {
  post_id: text().notNull(),
  subject: text().notNull(),
  emoji: text().notNull(),
  created_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.post_id, table.subject, table.emoji] }),
  index("screening_reaction_post").on(table.post_id),
]);

/** 红黑榜投票（2026-09-16,PLAN-20260916102339）：每人**每部片一票**，值为红 / 黑。
 *  唯一约束压住「同一个人反复点同一部」—— 改票走 update、撤票走 delete，聚合表永远等于人数。 */
export const filmVoteContribution = sqliteTable("film_vote_contribution", {
  edition: text().notNull(),
  film_key: text().notNull(),
  contributor: text().notNull(),
  vote: text().notNull(), // "red" | "black";白名单收口在 film-vote-stats.ts，不写 CHECK（旧行迁移过来时更宽松）
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.film_key, table.contributor] }),
  index("film_vote_contribution_contributor").on(table.edition, table.contributor),
]);

/** 每部影片的红 / 黑票数，供榜单读取（O(影片数)）。**不做加权** —— 贴纸是「一人一枚」的离散
 *  隐喻，3 个人贴了红就该显示 3（想看人数那套 0.75 / 1.0 权重会把这里读成 2.25）。 */
export const filmVoteStat = sqliteTable("film_vote_stat", {
  edition: text().notNull(),
  film_key: text().notNull(),
  red_count: integer().notNull().default(0),
  black_count: integer().notNull().default(0),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.film_key] }),
]);

/** 抢票结果：每位贡献者「每场最终怎样了」。形状与 `screening_attendance_contribution` 同构
 *  （2026-09-20，抢票分析模块）—— 那边记「谁把这场排进行程」，这边记「谁最后抢到没有」。
 *  ⚠ `outcome` 是四值而不是三值：`got` + `via=transfer`（票是别人转的）被归一成独立的
 *    `transfer`，这样「转票不进抢到率」这条业务规则在服务端只有一份实现（见 ticket-stats.ts）。 */
export const screeningTicketContribution = sqliteTable("screening_ticket_contribution", {
  edition: text().notNull(),
  code: text().notNull(),
  contributor: text().notNull(),
  outcome: text().notNull(), // "got" | "transfer" | "missed" | "dropped"；白名单收口在 ticket-stats.ts
  weight: text().notNull(), // 同 film_want_contribution：以文本存 "1" / "0.75"，避免 SQLite 浮点漂移
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.code, table.contributor] }),
  index("screening_ticket_contribution_contributor").on(table.edition, table.contributor),
]);

/** 每场次四项权重和（展示时 Math.round）。**刻意不设冗余的 `weight_sum`**：四项互斥、求和即总量，
 *  多一个冗余列只会迟早与四项之一漂移（`screening_attendance_stat` 只有一项求和，故它才需要）。 */
export const screeningTicketStat = sqliteTable("screening_ticket_stat", {
  edition: text().notNull(),
  code: text().notNull(),
  got_sum: text().notNull().default("0"),
  transfer_sum: text().notNull().default("0"),
  missed_sum: text().notNull().default("0"),
  dropped_sum: text().notNull().default("0"),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.code] }),
]);

/** 事件流水（2026-09-20，第 3 轮，PLAN-20260920203010 修订 2）——「哪些页面 / 哪些入口真的被用了」。
 *
 *  ⚠ 与前面四张贡献表**语义不同**：那四张是「状态」（谁选了哪部片），同一人重复标记只算一次；
 *    这张是「计数」（谁看了几次），所以要存 `hits` 而不是存在与否 —— 状态式建模会把
 *    「看了 100 次」和「看了 1 次」压成同一条记录，重复访问这一维度就永久丢失了。
 *  ⚠ `target` 是**受白名单约束的短标记**（路由键 / 入口 slug），校验收口在 `telemetry-stats.ts`：
 *    服务端只接受形如 `^[a-z0-9\-/:]+$` 的串 —— 这样即使客户端被改坏，也灌不进
 *    搜索词 / 人名 / 备注这类自由文本（本轮明确「搜索完全不进统计」）。
 *  ⚠ 保留期**永久**（用户 2026-09-20 明确要求），故没有 TTL 列。 */
export const telemetryContribution = sqliteTable("telemetry_contribution", {
  edition: text().notNull(),
  kind: text().notNull(), // "page" | "click"；白名单收口在 telemetry-stats.ts
  target: text().notNull(),
  contributor: text().notNull(),
  hits: integer().notNull().default(0),
  weight: text().notNull(), // 同 film_want_contribution：文本存 "1" / "0.75"
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.kind, table.target, table.contributor] }),
  index("telemetry_contribution_contributor").on(table.edition, table.contributor),
]);

/** 每个 (kind, target) 两个加权和。
 *  ★ **两个**和缺一不可，它们回答不同问题：
 *    `viewer_weight_sum` = 「多少人用过它」（去重），`hits_weight_sum` = 「总共用了多少次」。
 *    热度榜要按后者排（被反复用的是真入口），而「多少人看过」是前者的语义 —— 只留一个
 *    就得在展示层编一个假的另一个。 */
export const telemetryStat = sqliteTable("telemetry_stat", {
  edition: text().notNull(),
  kind: text().notNull(),
  target: text().notNull(),
  viewer_weight_sum: text().notNull().default("0"),
  hits_weight_sum: text().notNull().default("0"),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.kind, table.target] }),
]);

/**
 * **按天分桶**的增量账本（2026-09-23，PLAN-20260923142546，批 1）。
 *
 * 为什么要单独一张表：前面五张 `*_stat` 都只记「当前累计」，**没有时间维度** ——
 * 于是「今天有多少人想看」这类问题根本无法回答。要给趋势就得有人记「每天变了多少」。
 *
 * ⚠ 记的是**增量**（每次上报的差分），不是快照。所以它只能加，不能「覆盖」：
 *   把整份状态写进来等于同一天重复计数（写入侧的口径在 `stat-daily.ts`）。
 * ⚠ 日界是 **KST**，由服务端算（`day.ts`）—— 客户端传日期可伪造。
 * ⚠ **不记 contributor**：那是「谁在哪天做了什么」的长期留痕，体积与隐私都远超收益；
 *   要查身份走各自贡献表（它们本来就有）。
 * ⚠ 历史**不回填**：现有累计值拆不到天，硬拆就是编造数据（接口会回 `earliestDay` 让 UI 标注）。
 * ⚠ 两个加权和都是 TEXT：与其它表同口径（文本存 `"0.75"` / `"1"`，避开 SQLite 浮点漂移）。
 *   `hits_sum` 目前**只有 telemetry 用**（「总共用了多少次」），其余 metric 恒 `"0"` ——
 *   保留成 TEXT 而不是 INTEGER，是为了不丢匿名 0.75 的权重。
 */
export const statDaily = sqliteTable("stat_daily", {
  edition: text().notNull(),
  day: text().notNull(), // 'YYYY-MM-DD'（KST）
  metric: text().notNull(), // "want" | "vote" | "screening" | "ticket" | "telemetry"；白名单在 stat-daily.ts
  target: text().notNull(), // film key / 场次 code / `kind:target`
  weight_sum: text().notNull(),
  hits_sum: text().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.day, table.metric, table.target] }),
]);
