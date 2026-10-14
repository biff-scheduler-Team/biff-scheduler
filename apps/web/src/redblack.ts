// 电影红黑榜 —— 贴纸数据 / 排序 / 持久化(2026-09-16,PLAN-20260916102339)
//
// ⚠ 2026-10-14(PLAN-20261014190000):**投票入口**整体换成「快速投票」滑动卡片,本模块的口径随之变成:
//   · 左滑 = 黑票、右滑 = 红票、**上滑 = 跳过（不写任何状态，见下面那条修订）**;
//   · **落点与皮肤都在投票那一刻随机**(`voteSticker`)—— 用户不再拖、也不再挑款;
//   · 候选来自我的行程(`quick-vote.ts`);**已处理过的片(投过 / 跳过过)不再进队列**(修订 5),
//     所以卡片默认不会再看到已经贴过的那几部 —— 改票去榜单上点那一枚;
//   · 「标记看过」已删:`biff.redblack.watched.v1` 只作为**一次性清理**的旧键保留;
//   · 画布上「我贴的那一枚」是**只读**的(不能拖 / 不能双击收回 / 没有方向键与换肤轮盘)。
//
// ⚠ **2026-10-14 修订（同日第二次，用户拍板）**：「上滑 = 记一条『没看过』并上报」那条**作废**。
//   上滑就是**跳过** —— 一个字节都不写：
//   · 不动红黑票（已有红/黑评价的片被跳过之后**仍然是红/黑**，用户口径「跳过不应覆盖原有评价」）；
//   · 也不记第三种状态：一部片对一个人只有**两种**可能（红 / 黑），没贴过就是「未决定」——
//     那个状态不需要存储，它**就是** `board` 里没有这个 key。
//   于是 `biff.redblack.unseen.v1` 与 `LS_REDBLACK_UNSEEN` 一起变成**只清理不读写**的旧键
//   （与 `watched.v1` 同一个处置），服务端那第三态也一并撤掉。
//
// 保留下来的口径:
//   · **一部电影一枚贴纸**(红 / 黑二选一,贴上就没有第二个名额);
//   · 贴纸落在**卡片右侧的留白画布**上,位置是自由相对坐标 —— 允许重叠、每枚角度不同(±15°),
//     像线下手绘打卡墙,不做避让 / 吸附;
//   · 红 / 黑 是**同一个名额的两种取舍**,不是可以并存的两色。
//
// ⚠ 本模块是纯逻辑 + localStorage 读写,**import 期不碰 DOM**(单测挂内存 localStorage 替身即可)。

import { STICKER_SKIN_KEYS, type StickerSkin } from "@biff/contracts/sticker";
import { searchFilm, type FilmNode } from "./app/model";
import { normText } from "./util";
import { removeWorkspaceItem, writeWorkspaceItem } from "./workspace-storage";

export type StickerType = "red" | "black";

export type { StickerSkin };

/** 一枚已贴的贴纸。`posX` / `posY` 是**画布内的相对坐标(0..1)** —— 存像素会在换屏 /
 *  换列数之后跑到画布外面去(卡片宽度本来就不是定值)。
 *
 *  ⚠ `comment`(2026-09-29,PLAN-20260929181900)是**可选**字段 —— 加可空字段是**向后兼容**的,
 *    不触发 AGENTS §5 那条「改结构必须新 key + 一次性迁移 + 删旧 key」(那条管的是**不兼容**变更):
 *    老数据里没有它就是「这一票还没写评语」,读回来照旧能贴能读。
 *
 *  ⚠ 为什么评语要存在本地:公开读接口`刻意不回身份`(`film-vote-store.ts` 的硬约束),
 *    于是「大家说」列表里**认不出哪条是我写的** —— 「改我自己的评语」只能靠本地这一份。
 *    它同时是上报载荷里 `comment` 的来源(见 `voteInputsOf`)。 */
export interface Sticker {
  id: string;
  type: StickerType;
  posX: number;
  posY: number;
  comment?: string;
  /** 这一枚选的**皮肤**（2026-09-29）。与 `comment` 同理：加可空字段向后兼容，
   *  不触发「新 key + 一次性迁移 + 删旧 key」那条（那条管不兼容变更）。
   *  ⚠ 也**可以缺席**：老数据（用户说了会自己删）、以及 id 推导出来的群点在没有分布数据时。
   *    取款一律走 `resolveSkin(id, sticker.skin)`，别直接读它。 */
  skin?: StickerSkin;
}

/** 影片 key → 已贴贴纸(每种颜色最多 `MAX_PER_COLOR` 枚) */
export type StickerBoard = Map<string, Sticker[]>;

/** 榜单档位（2026-10-12 起**只留两榜**，PLAN-20261011235624）：
 *  · `red` = **红榜** —— 按**红票数**降序（贴纸多的在前）；
 *  · `black` = **黑榜** —— 按**黑票数**降序（贴纸多的在前）。
 *  ⚠ 票数相同再看评分（`scoreOf`）；两榜**不再**互为倒序 —— 2026-10-14 改按数量后，
 *    红榜 / 黑榜是两份**不同的**名单（2026-10-12 撤「总数榜」时的那条理由随之失效，但总数榜
 *    仍不恢复：用户没要，且「我贴过的」那节已由 `sortByTotal` 承担全站总数口径）。
 *  ⚠ 三次口径沿革（评分 → 分档 → 按数量）写在下面「排序」那一段，改之前先读。 */
export type SortMode = "red" | "black";

/** 当前结构(v2)。**独立键**:v1 是「槽位 + 一部一枚」的旧模型,互相不兼容。 */
export const LS_REDBLACK = "biff.redblack.v2";
/** 旧结构(槽位模型)—— 只作为一次性迁移源,读完即删 */
const LS_REDBLACK_V1 = "biff.redblack.v1";
/** ⚠ **已废弃**（2026-10-14 修订，PLAN-20261014190000）：上滑改成**纯跳过**之后，
 *  「没看过」不再是一个状态 —— 一部片对一个人只剩红 / 黑两种取值，没贴过就是「未决定」。
 *  这个键现在只在一次性清理（`purgeDemoLeavings`）里被删掉一次，**新代码不要再读写它**。
 *  （与 `watched.v1` 同一个处置：留着键名是为了把用户机器上那份旧数据扫干净。） */
const LS_REDBLACK_UNSEEN = "biff.redblack.unseen.v1";
/** ⚠ **已废弃**（2026-10-14，PLAN-20261014190000）：「标记看过」这道闸门整个撤掉了 ——
 *  投票不再需要先声明「看过」（上滑那句「没看过」本身就是一次表态）。
 *  这个键现在只在一次性清理（`purgeDemoLeavings`）里被删掉一次，新代码不要再读写它。 */
export const LS_REDBLACK_WATCHED = "biff.redblack.watched.v1";
/** ⚠ **已废弃**(2026-09-16):「示例铺底」功能已删 —— 正式环境就该是空的,让用户自己贴
 *  (用户原话:「正式环境不应该是空的让用户自己贴的吗」)。这个键现在只在一次性清理
 *  (`purgeDemoLeavings`) 里被删掉一次,新代码不要再读它。 */
export const LS_REDBLACK_SEEN = "biff.redblack.seen.v1";
/** 快速投票里**被我跳过过**的影片 key(2026-10-14,`PLAN-20261014190000` 修订 5)。
 *
 *  上滑「跳过」的语义是「这一张我翻过了、不想表态」——它**不写任何红黑状态**(本模块的既有口径)。
 *  但如果连「翻过」都不记,下次打开快速投票又从这一张开始,用户会觉得「划了等于没划」
 *  (用户原话:「是匿名态也要在浏览器缓存里面稍微记录一下通过快速投票的标记情况」)。
 *
 *  ⚠ 与 `biff.redblack.v2`(红黑票)**是两件事**,所以是两个键:
 *    那个回答「我表了什么态」,这个回答「我翻过哪几张」。撤回贴纸**不该**抹掉「翻过」,
 *    而「投过」的片同样不再进队列 —— 那一条由 `board` 直接判,不在这里再记一遍。
 *  ⚠ 只记 key、不记时间:队列过滤只需要「有没有」。 */
export const LS_REDBLACK_SKIPPED = "biff.redblack.skipped.v1";

/** 一部电影只有一枚贴纸(用户 2026-09-16 定:「标记看过只能选一个贴纸」)——
 *  红 / 黑是同一个名额的两种取舍,贴上就没得再贴,收回才重新可选。 */
export const MAX_PER_FILM = 1;

/** 落点边距(相对):贴纸中心不出这个范围,免得贴在画布最边上被裁掉一半 */
const SPOT_MARGIN = 0.08;

/** 落点的**向心强度**(2026-09-29,经两轮修订)。
 *
 *  用户第一次反馈:「分布比较均匀(几乎铺满了矩形各个角)……让中间密、边缘留白多一点」。
 *  第一版把它实现成了**极坐标圆盘撒点** —— 四角确实空了,但多出一条**看得见的椭圆边界**,
 *  用户随即反问「为什么现在贴纸聚成椭圆形了」。**教训:要的是密度的渐变,不是形状的改变。**
 *
 *  所以现在是:x / y 各自仍在**整个矩形**里取值(没有边界),只把两路均匀数**加权混合**,
 *  让分布从「均匀」偏向「中间高、四周低」:
 *  · `0` → 纯均匀(铺满四角,即改版前的观感);
 *  · `1` → 三角形分布(中点最密,向两端线性递减);
 *  · 取 `0.5`:看得出中间更密,而**边缘依然有点** —— 不会留下成片的空白。
 *
 *  ⚠ 2026-09-30 三次修订:用户反馈某片(红 165 · 黑 74)画布「空白的地方太多了」——
 *    票数不算少时,`0.5` 仍会把大部分点拉进中间一条带,四周(尤其上下)看着空得多。
 *    降到 `0.22`(比纯均匀 `0` 略偏一点密度渐变,但明显弱于 `0.5`)来填满空白;
 *    没有归零,是不想矫枉过正退回 2026-09-29 之前「铺满四角」被吐槽的版本。
 *
 *  ⚠ 只作用在落点推导(`spotOf` 群点 / `makeSticker` 我自己那枚)**共用** `softSpot`。 */
const SPOT_CENTER_BIAS = 0.22;

/** 一部片的**全体**红黑计数 —— 红黑榜是「全部用户都可以贴」的,这份计数**只来自服务端聚合**
 *  (`film-votes.ts::loadFilmVotes` + api 的 `/api/stats/film-votes`),本地绝不造:
 *  造出来的假数字会在接口上线后与真实票数打架(用户 2026-09-16 明确要求去掉模拟)。
 *  ⚠ 它与 `StickerBoard` 是两回事:`StickerBoard` 是**我自己**贴的那几枚(带坐标、可拖),
 *    这里是大家贴出来的**数量」。 */
export type CrowdCounts = Map<string, StickerCounts>;

/* ---------------- 位置与角度 ---------------- */

/** 字符串 → 稳定哈希(角度 / 落点 / 演示数据都用它推导,保证同一份输入每次结果一样)。
 *
 *  ⚠ 2026-09-29 起**对外导出**:贴纸的**形状族与中心微图标**也要从 id 推导
 *    (`sticker-shape.ts::shapeOf` / `sticker-glyph.ts::glyphOf`),而哈希只允许一处实现
 *    (AGENTS §5)—— 另写一份「差不多的哈希」迟早两处对不上。 */
export function hashOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 把坐标钳进画布的安全区(拖到画布外 / 边缘时用) */
export function clampSpot(posX: number, posY: number): { posX: number; posY: number } {
  const lo = SPOT_MARGIN;
  const hi = 1 - SPOT_MARGIN;
  return {
    posX: Math.min(hi, Math.max(lo, posX)),
    posY: Math.min(hi, Math.max(lo, posY)),
  };
}

/** 由贴纸 id 推导的**确定性**倾斜角(±15°)。
 *  ⚠ 角度不单独存字段:它是「这一枚长什么样」的装饰,由 id 推出来就永远稳定
 *    (存字段反而多一份可能与位置脱节的脏数据)。 */
export function tiltOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 1000003;
  return ((hash % 301) / 10) - 15; // -15.0 ~ +15.0
}

/** 由贴纸 id 推导的**确定性**皮肤 —— **只作兜底**（与 `tiltOf` / `spotOf` 同一模式）。
 *
 *  什么时候会走到：① 没带款的老票（迁移前写下的 / 旧客户端上报的）—— 服务端按款聚合
 *  覆盖不到它们，但它们在总数那本账里，不能丢；② 本地盘上还没选过款的老贴纸。
 *  用 id 推导而不是「一律默认款」，是为了让那部分票看起来仍然是一堆不一样的贴纸
 *  （与改动前的观感连续）。
 *
 *  ⚠ **为什么它住在这里而不是 `sticker-skin.ts`**：`crowdStickers`（本文件）要按 id 兜底，
 *    而 `sticker-skin.ts` 要用到本模块的 `hashOf` —— 推导放那边就是循环 import。
 *    「由 id 推导的装饰」本来就归本模块（`tiltOf` / `spotOf` 都在这儿）。
 *  ⚠ 款的白名单与中文名在 `@biff/contracts/sticker`，这里只读它的**顺序**。 */
export function derivedSkin(id: string): StickerSkin {
  return STICKER_SKIN_KEYS[hashOf(id) % STICKER_SKIN_KEYS.length];
}

/** 从契约层白名单里**随机**取一款（2026-10-14，PLAN-20261014190000）。
 *
 *  用户不再挑皮肤（换肤轮盘随贴纸操作一起撤掉），所以投票那一刻直接摇一款 ——
 *  展板仍然是一片不一样的贴纸，只是那一款不再代表任何选择。
 *
 *  ⚠ 顺序来自 `STICKER_SKIN_KEYS`（契约层唯一来源），不在本地再抄一份 id 列表。
 *  ⚠ 两头都夹一下：`rand()` 在无参时可能被注入返回 `1` 的坏种子（单测 / 边界），
 *    `Math.floor(1 * len)` 会越界成 `undefined`。 */
export function randomSkin(rand: () => number = Math.random): StickerSkin {
  const index = Math.floor(rand() * STICKER_SKIN_KEYS.length);
  return STICKER_SKIN_KEYS[Math.min(STICKER_SKIN_KEYS.length - 1, Math.max(0, index))];
}

/** 一部片的**按款票数**（服务端聚合回的那一份，稀疏：只含带款的票）。
 *  ⚠ 值里**刻意没有 `total`**，所以不复用 `StickerCounts`：服务端只回两色计数
 *    （总数另有权威那本账，见 `crowdStickers` 的说明），复用会让它变成类型错误。
 *    这不是省事与否的问题 —— 它把「总数」与「按款的细分」这两本账在**类型上**分开了。 */
export type SkinCrowdCounts = Partial<Record<StickerSkin, { red: number; black: number }>>;

/** 影片 key → 该片按款票数。**稀疏**：没有款数据的片不进这张表。
 *  ⚠ 别名放在这里（而不是 `film-votes.ts` 或海报那边各写一份）：它是三个消费端
 *    （页面状态 / 分享弹层 / 海报模型）共用的同一个形状，写两份迟早其中一处多一个可选字段。 */
export type FilmSkinCounts = Record<string, SkinCrowdCounts>;

/** 哈希的**雪崩**收尾(murmur3 的 fmix32)。
 *  ⚠ 不能直接拿 FNV 的高位当坐标:同一部片的贴纸 id 共享前缀(`cat:f001#crowd-`),
 *    而 FNV 的高位对**末尾那几个字符**几乎不敏感 —— 实测 `(hash >>> 20) % 1000`
 *    算出来的纵坐标会挤成一条横带(个别片 100 枚全落在上面 40% 里),画布根本没铺开。
 *    一天只画 16 枚时看不出来,**放开上限之后一眼就看出**(2026-09-22,PLAN-20260922145815 修订 2)。 */
function mix32(hash: number): number {
  let x = hash;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** **矩形里的一点**:四路 [0,1) 均匀输入 → 画布相对坐标。
 *
 *  `spotOf`(由 id 推导)与 `makeSticker`(随机)共用这一条式子 —— 否则会出现
 *  「群点都挤在中间、我刚贴的那一枚偏偏跑到角上」,一眼就看出是两套口径(AGENTS §5)。
 *
 *  ⚠ **不是极坐标**(2026-09-29 二次修订):第一版用圆盘撒点,四角是空了,但撒出了一条
 *  看得见的**椭圆边界**(用户当场反问「为什么聚成椭圆形了」)。这里 x / y 各自独立取遍整条边,
 *  向心只体现在**密度**上:把 `u1` 与 `u2` 按 `SPOT_CENTER_BIAS` 加权混合 ——
 *  `bias = 0` 退化成纯 `u1`(均匀),`bias = 1` 就是 `(u1 + u2) / 2`(三角形分布)。
 *  两个权重之和为 1,所以取值范围仍是 `[SPOT_MARGIN, 1 - SPOT_MARGIN]` 整段,没有被切掉一块。 */
function softSpot(ax: number, bx: number, ay: number, by: number): { posX: number; posY: number } {
  const span = 1 - SPOT_MARGIN * 2;
  const half = SPOT_CENTER_BIAS / 2;
  const pull = (u1: number, u2: number) => u1 * (1 - half) + u2 * half;
  return clampSpot(SPOT_MARGIN + pull(ax, bx) * span, SPOT_MARGIN + pull(ay, by) * span);
}

/** 由 id 推导的**确定性**落点 —— 迁移旧数据 / 画「别人的贴纸」都用它
 *  (不能用 `Math.random`,否则每次载入旧数据贴纸都会换位置)。
 *  ⚠ 取坐标前必须过一遍 `mix32`:见它的注释(不 mix 会挤成一条横带)。
 *
 *  ⚠ 分布口径见 `softSpot`:中间密、边缘疏,但形状仍是**矩形**、没有硬边界。
 *  ⚠ 仍然是**纯确定性**的:同一个 id 每次算出来还是同一个点,刷新不会换位置 ——
 *    `crowdStickers` 的叠放顺序 / 分享图 / 群点全依赖这条性质。 */
export function spotOf(id: string): { posX: number; posY: number } {
  const h1 = mix32(hashOf(id));
  // ⚠ 四路输入要用**两次** mix32:一次 32 位只够切两段干净的整数
  //   (`>>> 8` / `>>> 20` 各 12 位),再往下切 `>>> 30` 就只剩 2 位了。
  const h2 = mix32(h1 ^ 0x9e3779b9);
  return softSpot(
    ((h1 >>> 8) % 1000) / 1000,
    ((h1 >>> 20) % 1000) / 1000,
    ((h2 >>> 8) % 1000) / 1000,
    ((h2 >>> 20) % 1000) / 1000,
  );
}

/** 把「别人的贴纸」变成画布上能画出来的点:位置由 `(filmKey, index)` **确定性**推导,
 *  红票几枚就画几枚红、黑票几枚就画几枚黑。它们**只读**(不可拖)。
 *
 *  ⚠ 早先这里是 `min(total, 16)` **采样** + 按比例取整 + 「+N」角标 —— 那是为了让「16 枚」不被
 *    读成真实票数。2026-09-22 用户要求「一部片看全部贴纸」后**取消采样**(PLAN-20260922145815):
 *    采样除了让画布上的密度失真,还会**把少数派颜色四舍五入抹掉**(1 红 / 100 黑 → 一枚红点都没有,
 *    而卡片 chip 明明写着「红 1」)。点数变多的代价交给**渲染层**承担:
 *    视口外的卡不画、视口内的卡用 canvas 画(见 `components/StickerCanvas.tsx`)。 */
export function crowdStickers(
  filmKey: string,
  counts: StickerCounts | undefined,
  skins?: SkinCrowdCounts,
): Sticker[] {
  if (!counts || counts.total <= 0) return [];
  const reds = Math.min(Math.max(0, counts.red), counts.total);
  /** 把某一色的票摊成有序的「款」序列：先按契约层的款序铺**带款**的票，再补**没带款**的。
   *
   *  ⚠ `total` 是**总数那本账**（权威），按款聚合只覆盖带款的那部分 —— 两者对不上是正常的
   *    （迁移前的旧票就是没款的）。所以这里先铺款、再把差额用 `null` 补满，
   *    让调用方按 id 兜底 —— **绝不能丢掉差额**，丢了群点就比卡片上的数字少。
   *  ⚠ 反向也要挡住：聚合比总数还多（两次独立查询的快照差一拍）时按 `total` 截断，
   *    否则会画出比数字多的贴纸。 */
  const plan = (vote: StickerType, total: number): Array<StickerSkin | null> => {
    const out: Array<StickerSkin | null> = [];
    for (const skin of STICKER_SKIN_KEYS) {
      const n = Math.max(0, Math.trunc(skins?.[skin]?.[vote] ?? 0));
      for (let i = 0; i < n && out.length < total; i += 1) out.push(skin);
    }
    while (out.length < total) out.push(null);
    return out;
  };
  const redPlan = plan("red", reds);
  const blackPlan = plan("black", counts.total - reds);
  const out: Sticker[] = [];
  for (let i = 0; i < counts.total; i++) {
    const id = `${filmKey}#crowd-${i}`;
    const type: StickerType = i < reds ? "red" : "black";
    const picked = i < reds ? redPlan[i] : blackPlan[i - reds];
    out.push({ id, type, skin: picked ?? derivedSkin(id), ...spotOf(id) });
  }
  // 叠放顺序:**按落点纵坐标升序**(2026-09-28,PLAN-20260928003736)。
  // 上面那个循环把红票**整段**排在黑票之前,而 canvas / 分享图都是画家算法(后画的盖住先画的)
  // → 黑票永远压住红票(用户 2026-09-28 报的「黑色总是压住红色」)。三处消费的都是这一份数组
  // (卡片画布 / 分享图),改这里两处一起修好。
  // ⚠ 按 y 升序 = 上面(远)的先画、下面(近)的后画,于是近的压住远的 —— 读起来像「撒在倾斜桌面上
  //   的一堆纸片」。红黑在位置上本就哈希均匀分布,排序后两色自然交错,不再有谁被系统性压制。
  // ⚠ 二级键 `hashOf(id)` 只为打破「恰好同一 posY」的并列,保证**完全确定性**:
  //   同一份票数每次渲染顺序一致,不会刷新一下就换个压法。
  out.sort((a, b) => a.posY - b.posY || hashOf(a.id) - hashOf(b.id));
  return out;
}

/** 生成一枚新贴纸。**不给 `spot` 时落点随机**(点一下按钮就走这条,允许重叠、不避让);
 *  给了 `spot` 就用它(从暂存区拖到画布上松手的那一点)。
 *  `seed` 只为单测可复现而存在,真机走 `Math.random`。
 *  ⚠ 随机落点走 `softSpot` —— 与 `spotOf` **同一套分布**。两处一旦分家,
 *    「群点都挤在中心、我自己贴的那一枚跑到四角」当场可见(AGENTS §5)。 */
export function makeSticker(
  type: StickerType,
  spot?: { posX: number; posY: number },
  seed?: () => number,
): Sticker {
  const rand = seed ?? Math.random;
  const id = `s-${Date.now().toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`;
  // ⚠ 四次 `rand()` 的**次序**就是「x 的主 / 副、y 的主 / 副」(见 `softSpot`)——
  //   单测喂固定种子时靠它复现
  const at = spot ?? softSpot(rand(), rand(), rand(), rand());
  // ⚠ 这里的款是**按 id 推导**的兜底（与 `derivedSkin` 同一套），给「迁移前的老票 / 群点」用。
  //    **投票**那一刻走的不是这里，而是 `voteSticker`（款是随机摇的，见它的说明）。
  return { id, type, skin: derivedSkin(id), ...clampSpot(at.posX, at.posY) };
}

/** 快速投票**落下的一枚**：落点随机（`softSpot`）、皮肤随机（契约白名单）。
 *
 *  与 `makeSticker` 的分工：那个是「一枚贴纸」的通用构造（皮肤按 id 推导 —— 迁移前的老票与群点
 *  都靠它保持稳定）；这里是**用户投出一票**那一刻的构造 —— 从此位置与皮肤都不再是用户的选择
 *  （2026-10-14，PLAN-20261014190000）。
 *
 *  ⚠ 改票（同一部片换色）**不走这里**：那一条路是 `retintSticker`，位置与皮肤都原样保留 ——
 *    否则「把红改黑」会把那一枚顺手挪到别处、还换张脸，读起来像「又贴了一枚新的」。 */
export function voteSticker(type: StickerType, rand: () => number = Math.random): Sticker {
  const sticker = makeSticker(type, undefined, rand);
  return { ...sticker, skin: randomSkin(rand) };
}

/* ---------------- 统计 ---------------- */

export interface StickerCounts {
  total: number;
  red: number;
  black: number;
}

export function countsOf(list: readonly Sticker[] | undefined): StickerCounts {
  const total = list?.length ?? 0;
  let red = 0;
  for (const s of list ?? []) if (s.type === "red") red++;
  return { total, red, black: total - red };
}

/** 「以本地视角修正过的**全站**票数」= 服务端 `counts` **减去它里面属于我的那部分** (`serverMine`),
 *  再加上**我当前**贴的那几枚 (`mine`)。
 *
 * 为什么不能直接拿 `counts` 当全站(2026-09-23 用户报的「收回贴纸之后 贴纸仍残留」):
 * 贴 / 收回之后,服务端那份 `counts` 要等 1200ms 防抖上报 **+** 一次重拉才会更新。这期间若
 * 「全站 = counts、我的 = 本地 board」两边直接相减:
 *   · **收回** → 本地已归 0 而 `counts` 还含我 → 「别人的贴纸」凭空多一枚(就是那句「仍残留」);
 *   · **贴上** → 本地已有一枚而 `counts` 还没有 → 「别人的贴纸」凭空少一枚。
 * 把扣减基准换成 `serverMine`(服务端已确认含我的那份,见 `film-votes.ts::peekSyncedVotes`),
 * 两个方向都**立刻**正确,而服务端一确认就无跳动地切到真值。
 *
 * ⚠ 每色**先夹 0 再相加**:服务端已经撤掉而我这边还记着「它含我」(管理端删票 / 换设备)时,
 *    `counts − serverMine` 会是负数,直接加 `mine` 会把别人的票算少。 */
export function reconcile(
  counts: StickerCounts,
  serverMine: StickerCounts,
  mine: StickerCounts,
): StickerCounts {
  const red = Math.max(0, counts.red - serverMine.red) + mine.red;
  const black = Math.max(0, counts.black - serverMine.black) + mine.black;
  return { total: red + black, red, black };
}

/** 「**别人的**贴纸」= 全站票数 − 我自己那几枚。
 *  ⚠ 传进来的 `counts` 必须是**已经过 `reconcile` 的全站票数**(卡片与分享图都走那一条),
 *    否则「服务端还没算上我」/「服务端还留着我旧票」这两个窗口里会各错一枚
 *    (前者少画、后者多画 —— 后者正是用户报的那个 bug)。
 *  ⚠ 卡片画布(`StickerCanvas`)与分享图(`redblack-poster.ts`)必须共用这一条 ——
 *    两处各写一份,分享图上摊出来的贴纸数就会与卡片对不上。 */
/** 服务端已确认含我的那份票里，**我那一枚长什么样**（色 + 款）。
 *
 *  它是「从按款分布里扣掉我自己那一枚」的**唯一**基准（见 `othersSkins`），
 *  与 `redblack.ts::reconcile` 扣「两色总数」时用的那份快照是同一份（`film-votes.ts::synced`）。 */
export interface SyncedStickerFace {
  type: StickerType;
  /** 服务端那份里我这一票带的款。`null` = 没带款（迁移前的旧票 / 老客户端上报的）——
   *  ⚠ 这时**不能**按 id 兜底去扣：服务端按款聚合里根本没有我这一桶，扣了就是扣别人的。 */
  skin: StickerSkin | null;
}

/** 群点画的是**别人的贴纸**，所以「按款分布」也要扣掉我自己那一枚（2026-09-29）。
 *
 *  ⚠ 基准必须是**服务端已确认的**我那一面（`synced`），**不是本地当前贴的那一枚** ——
 *    这与 `othersOf` 靠 `serverMine` 扣减是**同一套口径**（2026-09-23「收回贴纸后仍残留」定下的），
 *    两处必须一起理解，改一处必须看另一处。
 *  ⚠ 2026-10-05 修的用户反馈（「换自己的贴纸皮肤，把红黑榜别人的皮肤也换了」）：
 *    改前这里拿**本地当前款**去扣，而换款到上报落地之间（1200ms 防抖 + 一次往返，失败还更久）
 *    服务端聚合里还是**旧款** —— 于是旧款那一桶没被扣（群点凭空多一枚「我旧款」），
 *    新款那一桶被白扣（某个**别人**的新款贴纸从群点里消失），两个方向同时发生。
 *  ⚠ 我这一票没带款 / 分布里没有我那一款 / 还没有分布数据（老接口、还没拉到）→ 原样返回：
 *    那是 `crowdStickers` 里「按 id 兜底」那条正常分支，不是错误。 */
export function othersSkins(
  counts: SkinCrowdCounts | undefined,
  synced: SyncedStickerFace | undefined,
): SkinCrowdCounts | undefined {
  if (!counts || !synced?.skin) return counts;
  const bucket = counts[synced.skin];
  if (!bucket) return counts;
  const left = bucket[synced.type] - 1;
  if (left < 0) return counts;
  return { ...counts, [synced.skin]: { ...bucket, [synced.type]: left } };
}

export function othersOf(counts: StickerCounts, mine: StickerCounts): StickerCounts {
  return {
    total: Math.max(0, counts.total - mine.total),
    red: Math.max(0, counts.red - mine.red),
    black: Math.max(0, counts.black - mine.black),
  };
}

/* ---------------- 快速投票:一次落定 ----------------
 * ⚠ 2026-10-14(PLAN-20261014190000):这一段取代了原来的 `FilmTally` / `tallyOf`(「标记看过 + 配额」)。
 *   现在不再有「先声明看过、再看还能贴几枚」这两层 —— 一次滑动就是一次落定,
 *   而「能不能投」只有一个条件:**这部片属不属于我的行程**(那个判断在 `quick-vote.ts` 里取候选时做掉)。
 *
 * ⚠ 这里刻意**不**返回「还能贴几枚」:那个数在旧模型里是给暂存区上那两枚红 / 黑按钮做禁用用的,
 *   而暂存区已经删了。留着它只会让调用方以为存在一条配额路径。 */

/** **快速投票的一次落定**:把这一部片设成红或黑。
 *
 *  · 已有贴纸 → **原地换色**(位置与皮肤都不动,像改主意而不是重贴);
 *  · 没有 → 新贴一枚(`voteSticker`:落点与皮肤都随机)。
 *
 *  ⚠ **跳过（上滑）不走这里** —— 它什么也不写（2026-10-14 修订）。调用方(卡片)因此不需要
 *    一个「把状态设成未决定」的入口：未决定就是**这个 `board` 里没有这个 key**，
 *    而「从有到无」在快速投票里根本不是一条用户能走的路（那是榜单上「收回贴纸」的事）。
 *
 *  ⚠ **幂等**，靠 `retintSticker` / `placeSticker` 的既有约定：内容没变时返回**同一个引用** ——
 *    所以「投了红再投红」调用方一看 `next === board` 就知道什么也没发生，不必自己比对。
 *  ⚠ `rand` 只在**真要新贴一枚**时才会被调用,所以单测可以传一个固定种子。 */
export function setFilmVote(
  board: StickerBoard,
  key: string,
  intent: StickerType,
  rand: () => number = Math.random,
): StickerBoard {
  const existing = board.get(key)?.[0];
  return existing
    ? retintSticker(board, key, existing.id, intent)
    : placeSticker(board, key, voteSticker(intent, rand));
}

/** 加权分里先验的**票数权重**（贝叶斯收缩的 `m`）。
 *
 *  ⚠ 取 `5` 是「温和」档：全站某片票数到 10 时先验只剩不到 1/3 的权重，票多的片基本按真实
 *    红占比走。调**大** → 更向全站平均收缩（冷门片更难冒头）；调**小** → 更接近纯占比，
 *    「1 红 0 黑 = 10 分」那种一票封顶就会回来。 */
export const PRIOR_VOTES = 5;

/** 全站红占比 —— 加权分里的先验 `C`。
 *  ⚠ 一票都没有时取**中性 0.5**（谁也没表态，不预设整个站偏爱红色）。 */
export function priorOf(crowd: CrowdCounts): number {
  let red = 0;
  let total = 0;
  for (const counts of crowd.values()) {
    red += counts.red;
    total += counts.total;
  }
  return total > 0 ? red / total : 0.5;
}

/** 红黑榜评分 = **加权红占比**，折算成 0–10 分（一位小数）。
 *
 *  公式 `WR = (red + m·C) / (total + m)`：`m` = `PRIOR_VOTES`、`C` = 全站红占比
 *  （IMDB Top 250 的加权评分同一手法）。它的作用是**抗小样本**——
 *  纯占比下「1 红 0 黑」= 10.0 会压过「47 红 3 黑」= 9.4 的口碑片；加权后两者分别是
 *  8.3 与 9.3（C = 0.8 时），口碑片正确胜出。
 *
 *  全红仍是最高的那一种（票多时趋近 10），全黑趋近 0；一枚都没贴 = `null`（显示成「—」）。
 *  ⚠ 分母只算**已贴**的贴纸：标记了但还没贴的是「待表态」，不是态度，不该拉低分数。 */
export function scoreOf(counts: StickerCounts, priorRate: number): number | null {
  if (!counts.total) return null;
  const prior = Number.isFinite(priorRate) ? Math.min(1, Math.max(0, priorRate)) : 0.5;
  const weighted = (counts.red + PRIOR_VOTES * prior) / (counts.total + PRIOR_VOTES);
  return Math.round(weighted * 100) / 10;
}

/* ---------------- 排序 ----------------
 * 主判据 = 那一榜**自己的票数**降序（红榜看**红**票、黑榜看**黑**票）—— 「贴纸多的在前」；
 * 票数相同时比**评分**（红榜高在前 / 黑榜低在前），再并列按目录序**稳定**排，不引入随机。
 * ⚠ 「一票都没有」的片两榜都排**最后**（单独一支，不受上面那个方向影响）。
 *
 * ⚠ **口径沿革**（三次改过，改动前先读完这一行，别再「顺手改回去」）：
 *   · 2026-10-12：撤「按数量」，改按**评分**（加权红占比 `scoreOf`）—— 为避免「1 红 0 黑 = 10.0」封顶；
 *   · 2026-10-14 上午：加**分档**（先比整数分档、档内比票数）—— 修「票多但占比略低反而排后面」；
 *   · 2026-10-14 下午（**当前**）：改回**按数量**（本段上面那两行）—— 因为评分是**占比**，
 *     「12 枚全红」永远压得过「58 枚 · 81% 红」；用户看到线上红榜榜首是 12 枚的片后拍的板。
 *     代价如实记着：红榜会变成**人气榜**，「红多但黑也多」的争议片会靠票量上前。
 * ⚠ `scoreOf` 没有删：它仍是**卡片角标 / 分享图上那个 `N.N 分`** 的来源，也是同票数时的次序。

/** 某一档的**入榜门槛**：该榜那一色至少有一票（红榜看红票、黑榜看黑票）。
 *  ⚠ 单独导出而不是埋在排序里：分享图要用它**筛掉「该榜为 0」的片**
 *    （黑榜里列一堆「黑 0」毫无意义），两处各写一份必然会漂移。
 *  ⚠ 门槛**不是**「评分 > 0」：一部全红的片评分很高，按升序照样会出现在黑榜末尾 —— 那就是错的。 */
export function boardHasVotes(counts: StickerCounts | undefined, mode: SortMode): boolean {
  if (!counts) return false;
  return mode === "red" ? counts.red > 0 : counts.black > 0;
}

/** 榜单排序：**按该榜自己的票数降序**（红榜看红票 / 黑榜看黑票），票数相同再比评分
 *  （红榜高在前 / 黑榜低在前），最后按目录序稳定。
 *  ⚠ 主判据为什么是票数而不是评分、以及三次口径沿革，见上面「排序」那一段 —— 别只看本函数。
 *  ⚠ 名字是 `sortByVotes` 不是 `sortByScore`：2026-10-14 改按数量后**评分不再是排序主判据**，
 *    名字留着 `Score` 就是骗人（调用方读名字就会以为它按分排）。 */
export function sortByVotes<T extends { key: string }>(
  films: readonly T[],
  counts: CrowdCounts,
  mode: SortMode,
  priorRate: number,
): T[] {
  /** 这一榜看的那一色票数（红榜看红、黑榜看黑）；一票没有的片是 0，但排序时另走「一律最后」 */
  const votesAt = (key: string): number => {
    const countsForFilm = counts.get(key);
    if (!countsForFilm) return 0;
    return mode === "red" ? countsForFilm.red : countsForFilm.black;
  };
  /** 评分；一票都没贴 → `null`（下面按「一律排最后」处理，**不**参与同票数比较） */
  const scoreAt = (key: string): number | null => {
    const countsForFilm = counts.get(key);
    return countsForFilm ? scoreOf(countsForFilm, priorRate) : null;
  };
  return films
    .map((film, index) => ({ film, index, votes: votesAt(film.key), score: scoreAt(film.key) }))
    .sort((a, b) => {
      // ① 一票都没有（评分 `null`）的片两榜都排**最后** —— 先处理它，否则会被下面的方向反转
      if (a.score === null || b.score === null) {
        if (a.score === b.score) return a.index - b.index;
        return a.score === null ? 1 : -1;
      }
      // ② 主判据：**票数降序**（「贴纸多的在前」）
      if (a.votes !== b.votes) return b.votes - a.votes;
      // ③ 同票数看**评分**（红榜高的在前 / 黑榜低的在前 = 更黑）
      if (a.score !== b.score) return mode === "red" ? b.score - a.score : a.score - b.score;
      // ④ 并列保序（传入顺序 = 目录序 → 中文名），刷新稳定
      return a.index - b.index;
    })
    .map((entry) => entry.film);
}

/** 「我贴过的」那一节的排序：按**全站总数**降序，并列保序。
 *  ⚠ 它不是榜单而是清单（「贴了多少列多少」），所以**不**跟着榜单走（榜单 2026-10-14 起按该色票数，
 *    而这里是红黑合计）。 */
export function sortByTotal<T extends { key: string }>(films: readonly T[], counts: CrowdCounts): T[] {
  return films
    .map((film, index) => ({ film, index }))
    .sort(
      (a, b) =>
        (counts.get(b.film.key)?.total ?? 0) - (counts.get(a.film.key)?.total ?? 0) ||
        a.index - b.index,
    )
    .map((entry) => entry.film);
}

/** 服务端返回的票数(纯对象) → 榜单用的 `CrowdCounts`。两色都空 / 非法取值的影片不进 Map ——
 *  与 `film-votes.ts::parseVotes` 同一道白名单,这里只负责**形状**转换。 */
export function crowdOf(
  votes: Readonly<Record<string, { red: number; black: number } | undefined>>,
): CrowdCounts {
  const out: CrowdCounts = new Map();
  for (const [key, counts] of Object.entries(votes)) {
    if (!key || !counts) continue;
    const red = Math.max(0, Math.trunc(Number(counts.red) || 0));
    const black = Math.max(0, Math.trunc(Number(counts.black) || 0));
    if (red <= 0 && black <= 0) continue;
    out.set(key, { total: red + black, red, black });
  }
  return out;
}

/** 一部影片票数的**内容签名** —— 只串「排序 / 绘制真正看的那三个数」。
 *  两处共用:① `crowdSignature`(整榜「有新贴纸」的判据)② 画布的**重绘守护**
 *  (`sticker-canvas-guard.ts`)。
 *  ⚠ 一律拿它比,**不要**比 `StickerCounts` 的对象引用:每次重算都是新对象,
 *   数字一模一样也会被当成「变了」——顺序提示会白亮一次、画布会白画一遍。 */
export function countsSignature(counts: StickerCounts): string {
  return `${counts.total},${counts.red},${counts.black}`;
}

/** 排序依据的**内容签名** —— 用来判断「票数是不是真的变了」(顺序冻结的提示判据)。
 *  ⚠ 不能拿 `FilmVoteCounts` / `CrowdCounts` 的**对象引用**比:每次重拉票数都会得到新对象,
 *   数字一模一样也会被当成「有新贴纸」,提示白亮一次
 *   (用户 2026-09-22:只在**数量变化**时才需要提示「有新贴纸 · 重新排序」)。
 *  只串排序真正看的那三个数,并按 key 排一次 —— 服务端返回顺序变了也不算变。 */
/** 一部的**按款**票数签名 —— 与 `countsSignature` 同一套手法（只串真正参与绘制的数）。
 *
 *  ⚠ 为什么它必须单独存在:画布的重绘守护比的是**值**。群点的外观现在由「按款分布」决定,
 *    而「有人把红票从撕裂圆片换成票根」这件事**不改变两色总数** —— 只看 `countsSignature`
 *    会把这次变化判成「不用重画」,画面停在旧分布上。 */
export function skinsSignature(counts: SkinCrowdCounts | undefined): string {
  if (!counts) return "";
  // ⚠ 缺的那几款要串成占位符，而不是跳过 —— 跳过的话「某一款从 2 变成 0」会留下同一个签名，
  //   于是那一次变化被判成「不用重画」，画面停在旧分布上。
  return STICKER_SKIN_KEYS.map((skin) => {
    const bucket = counts[skin];
    return `${skin}:${bucket ? `${bucket.red}.${bucket.black}` : "-"}`;
  }).join(",");
}

export function crowdSignature(counts: CrowdCounts): string {
  return [...counts]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, c]) => `${key}:${countsSignature(c)}`)
    .join("|");
}

/** 我的**状态** → 上报载荷。一部片一个人**只有一条**,`vote` 是三态(红 / 黑 / 没看过)。
 *
 *  ⚠ **`comment` / `skin` 字段一条都不能省**(2026-09-29,PLAN-20260929181900):服务端靠「这一份里
 *    有没有这个字段」分辨**新版前端**与**旧版前端** —— 一个都没带时它一个字都不碰那两列
 *    (否则老客户端一次普通上报就会**静默清空**用户写过的评语 / 选的款)。所以没有评语时送 `null`,
 *    而不是省略字段。 */
export function voteInputsOf(
  board: StickerBoard,
): Array<{ key: string; vote: StickerType; comment: string | null; skin: StickerSkin | null }> {
  const out: Array<{
    key: string;
    vote: StickerType;
    comment: string | null;
    skin: StickerSkin | null;
  }> = [];
  for (const [key, list] of board) {
    const sticker = list[0];
    if (sticker) {
      out.push({ key, vote: sticker.type, comment: sticker.comment ?? null, skin: sticker.skin ?? null });
    }
  }
  return out;
}

/** 「我的票」的内容签名 —— **只串影片 key 与颜色,与坐标无关**(2026-09-28)。
 *
 * 为什么需要它:拖动微调位置会换掉 `board` 的对象引用,而票一枚都没变。视图层若拿
 * `board` 当依赖,一次拖动就会 ① 触发一次全量上报(外加成功后那次重拉)、
 * ② 让「我的票」/ 修正票数 / 自己的配额 / 顶部统计全部重算一遍 —— 全都是白做。
 * 签名把「票变了」与「只是挪了个位置」分开,只有前者才让下游动。
 *
 * ⚠ 先按 key 排序再拼:`board` 的迭代序是插入序,换个插入顺序不该算「票变了」。
 *
 * ⚠ **评语必须进签名**(2026-09-29,PLAN-20260929181900):签名是上报 effect 的依赖
 *   (`RedBlackPage.tsx` 的 `votesKey`)。只串 key 与颜色的话,**改评语不会触发上报** ——
 *   用户写完一句,那句话永远上不去服务端(而且不报错、界面照旧)。
 * ⚠ 拖动那条路已经删了(`moveSticker` / 延后写盘随之一并撤掉),但「与坐标无关」这条性质仍是
 *   这个签名的**判据来源**:它回答的是「票变了吗」,而不是「board 这个对象换了吗」。
 * ⚠ 2026-10-14 修订:上滑不再写任何状态,所以签名也不再需要串「没看过」那本账 ——
 *   它现在**只**是「红黑票的内容签名」,一个参数就够。 */
export function votesSignature(board: StickerBoard): string {
  const parts: string[] = [];
  for (const [key, list] of board) {
    const sticker = list[0];
    // ⚠ `skin` 必须并进来（2026-09-29）：不然「只换了一款皮肤」时这个签名**没变**，
    //   而页面那条上报 effect 依赖的正是它 —— 用户换了款却永远同步不上去。
    if (sticker) parts.push(`${key}:${sticker.type}:${sticker.skin ?? ""}:${sticker.comment ?? ""}`);
  }
  return parts.sort().join("|");
}

/* ---------------- 变更(全部不可变:返回新 board) ----------------
 * ⚠ 纯函数里**不校验「这部片是不是在我的行程里」**:候选范围是视图层(`quick-vote.ts` 取候选)的概念,
 *   这一层只管数据结构。 */

function cloneBoard(board: StickerBoard): StickerBoard {
  return new Map([...board].map(([key, list]) => [key, list.map((s) => ({ ...s }))]));
}

/** 贴一枚;这一部已经有贴纸了 → **原样返回**(一部一枚的闸门) */
export function placeSticker(board: StickerBoard, key: string, sticker: Sticker): StickerBoard {
  const list = board.get(key) ?? [];
  if (list.length >= MAX_PER_FILM) return board;
  const next = cloneBoard(board);
  next.set(key, [...(next.get(key) ?? []), sticker]);
  return next;
}

/** 按 id 取下 */
export function takeSticker(board: StickerBoard, key: string, id: string): StickerBoard {
  const list = board.get(key);
  if (!list?.some((s) => s.id === id)) return board;
  const next = cloneBoard(board);
  const rest = (next.get(key) ?? []).filter((s) => s.id !== id);
  if (rest.length) next.set(key, rest);
  else next.delete(key);
  return next;
}

/* ⚠ 2026-10-14(PLAN-20261014190000):`moveSticker`(拖位置)**已删** —— 用户要的是
 *   「取消贴贴纸所有行为」,挪位置正是其中最费手的一件;而它的落点校验(`finishRef`)也只在拖拽那条路上有用。
 *   同理 `scheduleSaveStickers` / `flushPendingStickers`(延后写盘)**一并撤掉**:那套机制唯一的用途就是
 *   「拖动是装饰性写入、可以晚一拍落盘」——没有拖动之后,每一次写入都是语义操作,一律立即落盘。 */

/** 把**已经贴着的那一枚**原地换色:只改 `type`,**位置与 id 都保留**(2026-09-28)。
 *
 * 为什么需要它:一部一枚的口径下,「贴错了颜色」不该走「先收回、再重贴」(位置与皮肤都丢掉)。
 * 换色是同一个名额换了个态度,不是「再贴一枚」,所以它**绕开 `placeSticker` 的 `MAX_PER_FILM` 闸门**,
 * 直接改那一枚。
 * ★ 2026-10-14 起,「同一部片在一个名额上换态度」走的**就是这一条**:改票 = 原地换色
 *   (位置与皮肤都保留),读起来像「改了主意」而不是「又贴了一枚新的」。
 *   ⚠ 修订 5 之后快速投票的队列默认**不含**已经贴过的片(划过就不再来),所以要走到这里
 *     只有两条路:① 卡片里点了「再划一遍」;② 别处(`setFilmVote` 对外仍是幂等语义)。
 *
 * ⚠ 同色时原样返回**同一个引用**:调用方靠 `next === board` 就知道「这次点击什么也没做」,
 *   不必自己再比一次颜色(也让视图层能据此决定要不要弹提示)。 */
export function retintSticker(
  board: StickerBoard,
  key: string,
  id: string,
  type: StickerType,
): StickerBoard {
  const list = board.get(key);
  const index = list?.findIndex((sticker) => sticker.id === id) ?? -1;
  if (!list || index < 0 || list[index].type === type) return board;
  const next = cloneBoard(board);
  const target = next.get(key);
  if (!target) return board;
  target[index] = { ...target[index], type };
  return next;
}

/** 评语归一(本地这一侧):去掉首尾空白,**空串当作「没写」**。
 *
 * ⚠ **不在这里截断长度** —— 长度上限的**唯一收口在服务端**(`film-vote-stats.ts::normalizeComment`,
 *   按码点算 140)。在本地再定一个常量就是同一口径的第二份实现(AGENTS §5),
 *   而两处一旦漂移,「本地看着存下了、服务端截掉了」这种不一致极难解释。
 *   输入侧的上限由表单的 `maxLength` 承担(它只是**体验**上拦住,不是权威)。 */
export function normalizeStickerComment(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** 给**已经贴着的那一枚**写 / 改 / 清空评语。一人一片一票一评,所以只动那一枚。
 *
 * ⚠ 与 `retintSticker` / `placeSticker` 同一条:**不可变**;内容没变时返回**同一个引用** ——
 *   调用方(以及 `votesSignature` 那条上报链路)靠 `next === board` 就知道「这次什么也没做」,
 *   不必自己再比一次。
 * ⚠ 传空串 = **清掉评语**(写下去的是 `null`,服务端据此把那一列清空)。 */
export function setStickerComment(board: StickerBoard, key: string, comment: string): StickerBoard {
  const current = board.get(key)?.[0];
  if (!current) return board;
  const next = normalizeStickerComment(comment);
  if ((current.comment ?? undefined) === next) return board;
  const out = cloneBoard(board);
  const target = out.get(key);
  if (!target?.[0]) return board;
  // 先摘掉旧评语再按需写回:`comment` 是可选字段,清空时**删键**而不是留一个 `undefined`
  // (JSON.stringify 会丢掉 undefined,但内存里那份与读到的那份应当同形)。
  const kept = { ...target[0] };
  delete kept.comment;
  target[0] = next === undefined ? kept : { ...kept, comment: next };
  return out;
}

/* ---------------- 持久化 ----------------
 * v2(自由坐标)与 v1(槽位)结构不兼容 → **新键 + 一次性迁移 + 删旧键**(仓库惯例,见 `state.ts`)。
 * 读取端一律白名单 + 兜底:未知字段忽略,非法条目静默丢弃。 */

function readJson(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function parseV2(raw: unknown): StickerBoard {
  const board: StickerBoard = new Map();
  if (!raw || typeof raw !== "object") return board;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !Array.isArray(value)) continue;
    const list: Sticker[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const s = item as Partial<Sticker>;
      if (typeof s.id !== "string" || !s.id) continue;
      if (s.type !== "red" && s.type !== "black") continue;
      if (typeof s.posX !== "number" || !Number.isFinite(s.posX)) continue;
      if (typeof s.posY !== "number" || !Number.isFinite(s.posY)) continue;
      // 一部只留第一枚:数据损坏 / 旧模型残留时,宁可少一枚,也不要卡片上飘出两三枚贴纸
      if (list.length >= MAX_PER_FILM) continue;
      const spot = clampSpot(s.posX, s.posY);
      // 评语(2026-09-29):可选字段,过一遍本地归一(非字符串 / 空白串 = 没写),
      // 免得手改过的 localStorage 把「一个空串」当成一句评语报上去
      const comment = normalizeStickerComment(s.comment);
      list.push(comment === undefined
        ? { id: s.id, type: s.type, ...spot }
        : { id: s.id, type: s.type, ...spot, comment });
    }
    if (list.length) board.set(key, list);
  }
  return board;
}

/** v1(槽位模型)→ v2:丢掉槽位,按 id 推导一个稳定落点。
 *  槽位坐标是「哪一格」,没有跨结构的意义 —— 保留视觉上的分散即可。 */
function parseV1(raw: unknown): StickerBoard {
  const board: StickerBoard = new Map();
  if (!raw || typeof raw !== "object") return board;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !Array.isArray(value)) continue;
    const list: Sticker[] = [];
    value.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const s = item as { color?: unknown; slot?: unknown; type?: unknown };
      const type = s.type ?? s.color;
      if (type !== "red" && type !== "black") return;
      if (list.length >= MAX_PER_FILM) return;
      const id = `${key}#v1-${index}`;
      list.push({ id, type, ...spotOf(id) });
    });
    if (list.length) board.set(key, list);
  }
  return board;
}

export function loadStickers(): StickerBoard {
  const current = parseV2(readJson(LS_REDBLACK));
  if (current.size) return current;
  const legacy = parseV1(readJson(LS_REDBLACK_V1));
  if (!legacy.size) return current;
  // 迁移当场落盘并删旧键:否则 v2 一旦缺失,旧槽位数据会再被读一次(「数据复活」)
  saveStickers(legacy);
  try {
    removeWorkspaceItem(LS_REDBLACK_V1);
  } catch {
    /* 忽略 */
  }
  return legacy;
}

export function saveStickers(board: StickerBoard): void {
  try {
    writeWorkspaceItem(LS_REDBLACK, JSON.stringify(Object.fromEntries(board)));
  } catch {
    /* 忽略 */
  }
}

/** 读出「快速投票里跳过过」的 key 集合。
 *  ⚠ 读取端一律白名单(与 `parseV2` 同一条原则):非空字符串之外的一切静默丢弃 ——
 *    手改过的 localStorage 不该让队列过滤凭空少掉 / 多出几张卡。 */
export function loadSkipped(): Set<string> {
  const keys = new Set<string>();
  const raw = readJson(LS_REDBLACK_SKIPPED);
  if (!Array.isArray(raw)) return keys;
  for (const key of raw) {
    if (typeof key === "string" && key) keys.add(key);
  }
  return keys;
}

export function saveSkipped(keys: ReadonlySet<string>): void {
  try {
    writeWorkspaceItem(LS_REDBLACK_SKIPPED, JSON.stringify([...keys]));
  } catch {
    /* 忽略 */
  }
}

/* ⚠ 2026-10-14(修订):这里原来有一对 `loadUnseen` / `saveUnseen`（「没看过」那本账）。
 *   上滑改成**纯跳过**之后那个状态就不存在了 —— 一部片对一个人只剩红 / 黑两态,
 *   「未决定」**就是** `board` 里没有这个 key,不需要第二本账,也不需要第二次读写。
 *   与它对应的 `biff.redblack.unseen.v1` 现在只在 `purgeDemoLeavings` 里被清一次。 */

/** 榜单影片候选 —— **一部片一张卡**,两条规则(`PLAN-20261014112444`):
 *
 *  ① 有排期的影片照旧上榜(连场次都没有的目录片谈不上看过没看过);
 *  ② **「合集场次」自己不占卡,改由它的成员片各占一张**。
 *
 *  ★ 起因(用户原话):「我在红黑榜搜索 062 …出现的是 'Asian Short Film Competition 1',
 *    我希望出现的是和影片库一样是『她说』」——`062` 是「Asian Short Film Competition 1」
 *    这个短片竞赛合集场次的编号(一张票连看 5 部,官方排期没给中文名),合集里那 5 部
 *    (含《她说》)在榜上**既搜不到也贴不了票**(它们是「只在合集里放映」的目录片,`shows` 为空)。
 *
 *  ★ 成员片怎么找:**只用榜单自己那份 `films`,不查目录索引** —— 成员片的 `FilmNode.block`
 *    就是它所属的那个合集场次(`app/model.ts:100`),按它倒排即可。
 *    这同时**天然排除**了午夜联映块(`Midnight Passion 1/2/3`):它们的成员片
 *    (Sapiens / Angel′s Egg …)自己就有场次,节点是排期节点、**没有** `block`,
 *    倒排查不到成员 → 原样保留那张合集卡。这一条是**刻意**的,不是巧合:那些片在榜上
 *    本来就有落脚点,拆了只是把卡片弄没,还会让「搜合集编号」落空
 *    (成员片只认自己的场次编号,而它与合集编号不同)。判据因此可以一句话概括:
 *    **「成员片在榜上别无落脚点」的合集才拆。**
 *
 *  ⚠ **只拆能全部解析出成员的合集**:官方列出的成员名数与解析出的成员卡片数不一致时
 *    原样保留 —— 宁可少拆一次,也不能拆出一张「合集卡没了、某部成员片也没出现」的静默空洞。
 */
export function boardFilms(films: readonly FilmNode[]): FilmNode[] {
  // 成员片 → 所属合集场次 code 倒排。没有 `block` 的节点(排期片)天然不在表里。
  const membersOf = new Map<string, FilmNode[]>();
  for (const film of films) {
    const code = film.block?.code;
    if (!code) continue;
    const list = membersOf.get(code);
    if (list) list.push(film);
    else membersOf.set(code, [film]);
  }
  const out: FilmNode[] = [];
  const seen = new Set<string>();
  // 同一部片只出现一次:成员片来自多个场次(同一节目排了好几场),会被数到多次。
  const push = (film: FilmNode): void => {
    if (seen.has(film.key)) return;
    seen.add(film.key);
    out.push(film);
  };
  for (const film of films) {
    if (film.shows.length === 0) continue;
    const members: FilmNode[] = [];
    const memberKeys = new Set<string>();
    for (const s of film.shows) {
      for (const member of membersOf.get(s.code) ?? []) {
        if (memberKeys.has(member.key)) continue;
        memberKeys.add(member.key);
        members.push(member);
      }
    }
    const memberNames = new Set(film.shows.flatMap((s) => s.midnight_members ?? []));
    if (members.length === 0 || members.length !== memberNames.size) {
      push(film);
      continue;
    }
    for (const member of members) push(member);
  }
  return out;
}

/** 榜单搜索:影片自身的字段走 `app/model.ts::searchFilm`(片名 / 其余片名 / 元信息 / 场次编号),
 *  再补一条 —— **这张卡所属的合集场次**(`PLAN-20261014112444`)。
 *
 *  ★ 为什么必须有:榜单上的合集已被 `boardFilms` 拆成成员片,而成员片自己是「只在合集里放映」
 *    的目录片 —— `shows` 为空,`searchFilm` 的「场次编号」那一段**恒不命中**。
 *    不补的话,改动前「搜 062」只是搜到一张顶着英文单元名的卡,改动后会变成**一张都不剩**。
 *  ⚠ 只认场次编号与合集片名(中 / 英),不把合集当成可贴票的对象 —— 它只是成员片的入口。 */
export function searchBoardFilm(film: FilmNode, query: string): boolean {
  if (searchFilm(film, query)) return true;
  const block = film.block;
  if (!block) return false;
  const keyword = normText(query);
  if (!keyword) return true;
  return [block.code, block.title_en, block.title_zh].some((value) => normText(value).includes(keyword));
}

/* ---------------- 清理「示例铺底」的残留(2026-09-16) ----------------
 * 早先版本首次进入会**自动铺一份示例贴纸**(本意是让空榜也能看出颜色分布与排序),
 * 用户指出正式环境就该是空的(「正式环境不应该是空的让用户自己贴的吗」),该功能已删。
 * 这里只负责把**已经铺出去**的那批数据收干净 —— 否则老用户本地那份会一直顶着一堆
 * 自己从没贴过的贴纸,光删代码救不了他们。 */

/** 示例贴纸的 id 前缀(铺底时代生成的贴纸长这样;用户自己贴的是 `s-` 前缀) */
const DEMO_ID_PREFIX = "demo-";

/**
 * 清掉示例残留,返回清理后的 `board`(页面载入时调一次)。
 *
 * 判据分两档,**保守优先**:
 *  ① 贴纸**全部**是示例生成的(或压根没有贴纸)→ 整份都是自动铺的,board 清空;
 *  ② 混着自己贴的(存在 `s-` 前缀)→ **只摘掉示例那几枚**,用户自己的贴纸一律不动。
 *
 * ⚠ 只在确实读到示例残留时才写盘:清一次即止,之后每次载入都是空转。
 * ⚠ 2026-10-14(PLAN-20261014190000):「标记看过」那道闸门撤掉了,所以这里**不再返回也不写
 *    `watched`**;顺带把**废弃的两只键**各删掉一次。它们今天一样都读不到东西,但形状都是
 *    「影片 key 数组」—— 留着迟早有人读错（尤其 `unseen.v1`，它曾经真的是一个状态）。
 */
export function purgeDemoLeavings(): { board: StickerBoard } {
  // ⚠ 废弃键的清理放在**最前面、且无条件**:它跟「有没有示例残留」毫无关系。
  //   挂进下面任一条分支里的话,「恰好有自己贴的贴纸」的那次载入就永远清不掉它。
  for (const retired of [LS_REDBLACK_WATCHED, LS_REDBLACK_UNSEEN]) {
    try {
      removeWorkspaceItem(retired);
    } catch {
      /* 忽略 */
    }
  }

  const stored = loadStickers();
  const stickers = [...stored.values()].flat();
  if (!stickers.some((s) => s.id.startsWith(DEMO_ID_PREFIX))) {
    // 没有示例残留 —— 顺手把「关掉示例」那个废弃键收掉(功能没了,留着只是一份垃圾数据)
    try {
      removeWorkspaceItem(LS_REDBLACK_SEEN);
    } catch {
      /* 忽略 */
    }
    return { board: stored };
  }

  const mine = stickers.filter((s) => !s.id.startsWith(DEMO_ID_PREFIX));
  if (!mine.length) {
    const empty: StickerBoard = new Map();
    saveStickers(empty);
    try {
      removeWorkspaceItem(LS_REDBLACK_SEEN);
    } catch {
      /* 忽略 */
    }
    return { board: empty };
  }

  const board: StickerBoard = new Map();
  for (const [key, list] of stored) {
    const kept = list.filter((s) => !s.id.startsWith(DEMO_ID_PREFIX));
    if (kept.length) board.set(key, kept);
  }
  saveStickers(board);
  return { board };
}
