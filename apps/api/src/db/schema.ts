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
  /** 评语正文（2026-09-29，PLAN-20260929181900）。`null` = 只贴了纸、没写评语
   *  （「从来没写」与「写了又清空」同值 —— 两者对读的人没有区别）。 */
  comment: text(),
  /** 写入时**快照**的账号昵称；匿名 / 未登录时为 `null`（前端显示「匿名观众」）。
   *  ⚠ 与 `contributor` 是**两件事**：那个是身份标识、绝不外发（见 `film-vote-store.ts` 的说明）；
   *    这个就是给人看的名字，可以公开。用快照而不是 join 账号表：
   *    ① 昵称会变，评语读的是「当时那句话是谁说的」；② 公开接口不必碰账号库。 */
  display_name: text(),
  /** 这一票选的贴纸**款**（2026-09-29）。`null` = 迁移前写下的旧票 / 旧客户端上报的票。
   *  ⚠ 必须落在**贡献行**上，不能只存在按款聚合表里：`replaceContributorVotes` 走的是**差分**
   *    （见 `film-vote-stats.ts::diffVotes`），要把聚合减回去就得知道「上一枚是什么款」——
   *    不存这一列，改款时只能凭空猜一个旧值，聚合迟早对不上且永不自愈。
   *  ⚠ 白名单收口在 `film-vote-stats.ts`（与 `vote` 同一道），这里不写 CHECK。 */
  skin: text(),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.film_key, table.contributor] }),
  index("film_vote_contribution_contributor").on(table.edition, table.contributor),
  // 「大家的评语」按时间倒序拉取走这条（2026-09-29）。上面那条是「按人查我的票」，
  // 查询形状完全不同、走不上 —— 不加索引会全表扫。
  index("film_vote_contribution_recent").on(table.edition, table.updated_at),
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

/** 每部影片**按款**的票数（2026-09-29）。只服务一件事：展板上的群点要画出
 *  「大家各自选了什么款」—— 而那不能靠每次 `GROUP BY` 贡献表（榜单一次要读几百部片，
 *  与 `film_vote_stat` 存在的理由完全相同）。
 *
 *  ⚠ **这是聚合，不是名单**：主键里没有 `contributor`，公开读接口因此只可能回计数。
 *    与 `film_vote_contribution` 那条「身份标识绝不出公开接口」的约束天然一致。
 *  ⚠ 与 `film_vote_stat` 的关系是「同一件事的细分」：两表都按差分同步，
 *    但 `film_vote_stat` 的红黑总数是**权威**（旧票也在内；本表只覆盖带款的那部分）。 */
export const filmVoteSkinStat = sqliteTable("film_vote_skin_stat", {
  edition: text().notNull(),
  film_key: text().notNull(),
  /** 皮肤 id，白名单收口在 `film-vote-stats.ts` */
  skin: text().notNull(),
  vote: text().notNull(), // "red" | "black"
  count: integer().notNull().default(0),
  updated_at: integer().notNull(),
}, (table) => [
  // ⚠ 主键带 `(skin, vote)` 两维，而不是「一款一行、红黑两列」：后者等于把「款」写进列名，
  //   加一款就要改表。这样同一部片最多 3 款 × 2 色 = 6 行，仍然可枚举。
  primaryKey({ columns: [table.edition, table.film_key, table.skin, table.vote] }),
]);

/** 「这台设备报到第几批了」—— 增量上报的**幂等水位**（2026-10-05，PLAN-20261005182415 §C）。
 *
 *  ⚠ 主键带 `client_id`：`seq` 是**每台设备各数各的**（各自 1..N）。少了这一维，两台设备会用
 *    同一个 `contributor` 互相把对方的 seq 当成「已落过的重放」跳过 —— 表现就是「我这台贴的票上不去」。
 *  ⚠ 这里**没有任何票的内容**，只是一张水位表：写路径按 `ops` 合并出「目标状态」再交给
 *    `writeVotesDiff`，本表只回答「这一批是不是已经落过了」。
 *  ⚠ 水位只在**票写完之后**才推进（见 `applyVoteOps`）：中途失败时水位不动 ⇒ 客户端重发同一批 ⇒
 *    因为每个 op 都是「把这部片设成某状态」，重放天然幂等。
 *  ⚠ 只增不改：换浏览器 / 清缓存会留下孤儿行，无害（一行几十字节，也不含身份以外的信息）。 */
export const filmVoteSync = sqliteTable("film_vote_sync", {
  edition: text().notNull(),
  contributor: text().notNull(),
  /** 客户端生成的**设备标识**（落 `iffday.workspace.redblackclient.v1`，随机串）。
   *  ⚠ 它不是身份：身份仍然是 `contributor`（匿名 cookie 的 hash / 账号 subject）。 */
  client_id: text().notNull(),
  /** 这台设备**已经落库**的最大批次号；`seq <= last_seq` 的批次一律跳过。 */
  last_seq: integer().notNull().default(0),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.edition, table.contributor, table.client_id] }),
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
