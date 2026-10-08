// 红黑榜分享图(2026-09-22)—— 「分享文案」/「看片计划海报」之外的又一个出口。
//
// ★ 分层与 `poster.ts` 同口径:本文件 = **模型 + 几何 + 绘制**,import 期不碰 DOM,
//   可被 node 单测直接 import(所以日历 / 日期都靠注入,不读系统时钟)。
//   弹层 / 剪贴板 / 下载 = `components/RedBlackShareDialog.tsx`。
//
// ★ 三类内容,一次说清(用户 2026-09-22 定):
//   ① **总数榜 / 红榜 / 黑榜 各 TOP10** —— 判据**逐字复用页面那三个档位**(`redblack.ts::sortByCounts`),
//      不另立一套排名规则:分享图上看到的顺序必须与页面上点同档位时看到的一致。
//   ② **我贴过的** —— **不限条数**(贴了多少列多少),每行给「我贴的那一色 + 全站红黑数」。
//   ③ 底部署名:网站 + 作者。
//
// ★ 与 `poster.ts` 共用 `poster-brush.ts` 的配色 / 字体 / 圆角 / 超采样 / 品牌红条 ——
//   同一个应用出的两张分享图应当像一家人(§5 口径单一来源)。

import type { FilmNode } from "./app/model";
import { EDITION } from "./edition";
import {
  ACCENT_H,
  COLORS as C,
  FOOTER_H,
  PAD,
  POSTER_W,
  drawAccentBars,
  drawRule,
  fitText,
  posterFont as font,
  posterPixels,
  roundRectPath,
} from "./poster-brush";
import { glyphPath, glyphPlacement, type StickerGlyph } from "./sticker-glyph";
import { paintMaterial } from "./sticker-material";
import { shapePath, type StickerShape } from "./sticker-shape";
import { FALLBACK_SKIN, resolveSkin, skinSpec, type StickerSkin } from "./sticker-skin";
import { dateInfo } from "./util";
import {
  boardFilms,
  countsOf,
  crowdStickers,
  othersOf,
  othersSkins,
  sortByCounts,
  sortMetric,
  tiltOf,
  type CrowdCounts,
  type FilmSkinCounts,
  type SortMode,
  type Sticker,
  type StickerBoard,
  type StickerCounts,
  type StickerType,
  type SyncedStickerFace,
} from "./redblack";

/** 每个榜取前几名 */
export const TOP_N = 10;

/** 网站署名 —— 与页面页脚同源(`App.tsx` 的页脚也用这个域名)。 */
export const SITE = "biff.lcandy.co";
/** 作者署名 —— 与页面页脚**逐字一致**(`App.tsx`:「by @gaaiyeoi 和 by @lcandy2」)。
 *  ⚠ 两个 handle 都是**GitHub 账号名**(不是提交者显示名 `citron`):图片上没有链接,
 *    印一个搜不到的显示名等于没署名。改这里必须同步 `App.tsx` 的页脚。 */
export const CREDIT_BY = "by @gaaiyeoi 和 by @lcandy2";

/** 分享图上要摊开的一枚贴纸 —— 只有位置与歪斜(没有交互,是死像素)。
 *  ⚠ 落点 / 歪斜**不在这里算**:两者都由 `redblack.ts::spotOf` / `tiltOf` 从 id 确定性推导,
 *    这里只是把结果搬进模型,好让「画了几枚、什么颜色」能被单测断言。 */
export interface RbPosterSticker {
  id: string;
  type: StickerType;
  /** 0–1 相对坐标(贴纸**中心**)—— 与卡片画布同一口径 */
  posX: number;
  posY: number;
  /** 角度(度),±15 */
  tilt: number;
  /** 这一枚的**皮肤**（2026-09-29）。⚠ 在模型里就**解析成确定值**（而不是留 `skin?`）：
   *  分享图是**死像素**，没有 hover 也没有回落余地 —— 画的时候再解析一次就是第二处口径。 */
  skin: StickerSkin;
}

export interface RbPosterRow {
  key: string;
  /** 片名(中文优先,与页面卡片一致) */
  title: string;
  /** 英文名,可能为空 */
  en: string;
  /** 全站红 / 黑票数 */
  red: number;
  black: number;
  /** 我贴的那一色;没贴过 = null */
  mine: "red" | "black" | null;
  /** 这一行要摊出来的**全部**贴纸(别人的 + 我那一枚)。
   *  ⚠ 数量恒等于 `red + black` —— 用户口径是「几枚就画几枚」,分享图上也不打折。 */
  stickers: RbPosterSticker[];
  /** 我那一枚在 `stickers` 里的下标(绘制时加一圈亮边);没贴过 = -1 */
  mineIndex: number;
  /** 影片海报相对路径 —— 目录里有才带(缺图是常态,250 部里 174 部有)。
   *  ⚠ 与页面卡片 / 「看片计划海报」同一条来源(`FilmNode.poster`);缺图时**不编一个**路径,
   *    绘制层据此走占位块。 */
  poster?: string;
}

export interface RbPosterBoard {
  mode: SortMode;
  /** 「总数榜」/「红榜」/「黑榜」 */
  label: string;
  /** 口径说明,例如「按红贴纸数」 */
  hint: string;
  rows: RbPosterRow[];
}

export interface RbPosterModel {
  eyebrow: string;
  title: string;
  subtitle: string;
  /** 全站聚合(与页面 hero 的大字同一份数字) */
  site: { total: number; red: number; black: number; films: number };
  /** 我的(与页面 hero 那行小字同一份数字) */
  mine: { marked: number; placed: number; quota: number };
  boards: RbPosterBoard[];
  /** 我贴过的 —— 不限条数 */
  myTitle: string;
  myHint: string;
  myRows: RbPosterRow[];
  /** 勾掉的节不画,但**文案照旧**(「我贴过的 60 部」不因为没勾就变成 0 部) */
  myCount: number;
  /** 图里一节都没有时画这一句 —— 分成「没勾」与「真的没票」两种,别把「你还没选」说成「榜上没贴纸」 */
  emptyText: string;
  credit: { site: string; by: string };
}

export interface RbPosterInput {
  films: readonly FilmNode[];
  crowd: CrowdCounts;
  /** 影片 key → 该片**按款**票数（2026-09-29）。**含我自己那一枚**，用前 `othersSkins` 扣。
   *  ⚠ 缺席是**合法状态**（老接口 / 最小模型）：群点退回「按 id 兜底」，
   *    观感与加皮肤前一致 —— 不知道就别装作知道。 */
  skins?: FilmSkinCounts;
  /** 影片 key → **服务端已确认**的我那一枚（色 + 款）—— `othersSkins` 扣减时的基准。
   *  ⚠ 必须是 synced 快照（`film-votes.ts::peekSyncedFaces`），**不是**本地 board：
   *    换款到上报落地之间本地已经是新款、而服务端聚合里还是旧款，拿本地款去扣会从**别人的**
   *    桶里扣掉一枚（用户 2026-10-05 报的「换自己的皮肤把别人的也换了」，分享图同款 bug）。
   *  ⚠ 缺席 = 当作「服务端那份里没有我」→ 不扣（与卡片那边同一条口径，不知道就别装作知道）。 */
  syncedFaces?: ReadonlyMap<string, SyncedStickerFace>;
  board: StickerBoard;
  /** 页面 hero 那份「全站」统计 —— **传进来而不是重算**,分享图与页面才会是同一些数字 */
  site: { total: number; red: number; black: number };
  /** 页面 hero 那份「我的」统计 */
  mine: { marked: number; placed: number; quota: number };
  /** 出图日期 —— **注入**而不是读时钟:否则单测断不了文案 */
  today: Date;
  /** 要分享哪几节(用户勾选)。**不传 = 全选** —— 分享图默认给全,是「少给」才需要动作 */
  sections?: ReadonlySet<RbPosterSection>;
}

const BOARDS: ReadonlyArray<{ mode: SortMode; label: string; hint: string }> = [
  { mode: "total", label: "总数榜", hint: "按红 + 黑贴纸数" },
  { mode: "red", label: "红榜", hint: "按红贴纸数" },
  { mode: "black", label: "黑榜", hint: "按黑贴纸数" },
];

/** 长图里**可以单独勾掉**的节。
 *  为什么要有这个:榜单是「全站看法」,不是每个人都愿意把三榜全发出去
 *  (2026-09-22 用户:「分享的时候 选一下需要分享的长图内容吧 有的人不想所有的榜单都分享」)。
 *  ⚠ 顺序 = 渲染顺序,不随勾选顺序变(先总数 / 红 / 黑,「我贴过的」收尾)。 */
export type RbPosterSection = SortMode | "mine";

/** 可勾选的节 —— 榜的名字**只写 `BOARDS` 那一份**(别在这里再抄一遍)。 */
export const POSTER_SECTIONS: ReadonlyArray<{ id: RbPosterSection; label: string }> = [
  ...BOARDS.map((b) => ({ id: b.mode as RbPosterSection, label: b.label })),
  { id: "mine", label: "我贴过的" },
];

/** 默认全选(弹层刚打开时的样子)。返回**新** Set:调用方各持一份,别共享一个可变对象。 */
export function allSections(): Set<RbPosterSection> {
  return new Set(POSTER_SECTIONS.map((s) => s.id));
}

function isoDate(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function toSticker(s: Sticker): RbPosterSticker {
  return {
    id: s.id,
    type: s.type,
    posX: s.posX,
    posY: s.posY,
    tilt: tiltOf(s.id),
    // 与页面**同一套解析**（存了用存的、没存按 id 兜底），所以分享图和卡片上长得一样
    skin: resolveSkin(s.id, s.skin),
  };
}

function toRow(
  film: FilmNode,
  crowd: CrowdCounts,
  board: StickerBoard,
  skins: FilmSkinCounts,
  syncedFaces: ReadonlyMap<string, SyncedStickerFace>,
): RbPosterRow {
  const counts: StickerCounts = crowd.get(film.key) ?? { total: 0, red: 0, black: 0 };
  const placed = board.get(film.key) ?? [];
  const mine = countsOf(placed);
  // 群点 = 「别人的」(全体 − 我),与卡片画布同一条口径;我那一枚**追加在末尾** ——
  // 绘制顺序决定压叠次序,卡片上也是它压在群点之上(用户 2026-09-22 的口径)。
  // ⚠ 按款分布同样要**扣掉我自己那一枚**（与卡片里 `crowdSkins` 同一条口径、同一支函数）。
  //   不扣的话分享图会比卡片多画一枚 —— 而它恰好是我的款与色，看起来还挺合理，
  //   所以只能靠这条口径挡住：**两条路径的扣减必须来自同一个函数**。
  // ⚠ 基准是「服务端已确认的我那一面」（`syncedFaces`），**不是本地 board** —— 见 `RbPosterInput`。
  const stickers = crowdStickers(
    film.key,
    othersOf(counts, mine),
    othersSkins(skins[film.key], syncedFaces.get(film.key)),
  ).map(toSticker);
  // 一部只有一枚贴纸(`MAX_PER_FILM = 1`),取第一枚就是「我贴的那一色」
  const mySticker = placed[0];
  const mineIndex = mySticker ? stickers.push(toSticker(mySticker)) - 1 : -1;
  return {
    key: film.key,
    title: film.zh,
    // ⚠ 与页面卡片同一条**展示**规则(`RbCard`):中英名相同时不重复画一遍 ——
    //   排期里只有英文名的片(「In Winter」这类)否则会上下两行一模一样
    en: film.en && film.en !== film.zh ? film.en : "",
    red: counts.red,
    black: counts.black,
    mine: mySticker?.type ?? null,
    stickers,
    mineIndex,
    // 与页面卡片 / 「看片计划海报」同一条来源;缺图时留 `undefined`,绘制层据此走占位块
    poster: film.poster,
  };
}

/** 缺省的空「synced 外观表」—— 共用一份，免得每次调用造新 Map（与 `skins = {}` 同一个手法）。 */
const NO_SYNCED_FACES: ReadonlyMap<string, SyncedStickerFace> = new Map();

/**
 * 构建分享图模型。
 *
 * ⚠ 两条**展示**规则(不是排名规则,故不写在 `sortByCounts` 里):
 *  ① **该榜指标为 0 的片不进该榜** —— 黑榜里列一堆「黑 0」毫无意义;票不够 10 部时榜就短一些。
 *     ⚠ 按**每榜各自的指标**筛(`redblack.ts::sortMetric`),不是笼统的「有没有票」:
 *       只看「总数大于 0」的话,一部 3 红 0 黑 的片会照样出现在黑榜里。
 *  ② 三榜都取**前 `TOP_N`**;「我贴过的」那一节**不截断**。
 */
export function buildRbPosterModel(input: RbPosterInput): RbPosterModel {
  const { films, crowd, board, skins = {}, syncedFaces = NO_SYNCED_FACES, site, mine, today } = input;
  const picked = input.sections ?? allSections();
  const candidates = boardFilms(films);

  // 勾掉的榜**连算都不算**(不是算完再藏起来):少一节就该少一节的开销
  const boards: RbPosterBoard[] = BOARDS.filter((entry) => picked.has(entry.mode))
    .map((entry) => {
      const rows = sortByCounts(
        candidates.filter((film) => sortMetric(crowd.get(film.key), entry.mode) > 0),
        crowd,
        entry.mode,
      )
        .slice(0, TOP_N)
        .map((film) => toRow(film, crowd, board, skins, syncedFaces));
      return { ...entry, rows };
    })
    .filter((entry) => entry.rows.length > 0);

  // 我贴过的:按**全站总数**降序(与页面默认档同口径),并列按目录序 —— `sortByCounts` 自带稳定序
  const placedFilms = sortByCounts(
    candidates.filter((film) => (board.get(film.key)?.length ?? 0) > 0),
    crowd,
    "total",
  );
  const myRows = picked.has("mine")
    ? placedFilms.map((film) => toRow(film, crowd, board, skins, syncedFaces))
    : [];

  return {
    eyebrow: `${EDITION.replace("-", " ").toUpperCase()} · 观影红黑榜`,
    title: "红黑榜",
    // 日期走全站唯一口径（`OCT 8`），此前直接印 `isoDate` 的 `2026-10-08` —— 同一张海报两种写法
    subtitle: `${dateInfo(isoDate(today)).label} · ${candidates.length} 部有排期的影片`,
    site: { ...site, films: candidates.length },
    mine,
    boards,
    myTitle: `我贴过的 ${placedFilms.length} 部`,
    // 右侧那块贴纸区是这一节的主角(它才回答「我贴的那一部长什么样」),左侧圆点只是「我贴的是哪一色」
    myHint: "左侧圆点是我贴的那一色 · 右侧是这部片收到的全部贴纸",
    myRows,
    myCount: placedFilms.length,
    // ⚠ 「一节都没勾」与「真的没有票」是两回事,不能共用一句话
    emptyText:
      picked.size === 0
        ? "还没选要分享的内容 —— 勾上「长图内容」里的榜单再出图。"
        : "榜上还没有贴纸 —— 去「看过」的片子上贴一枚红或黑吧。",
    credit: { site: SITE, by: CREDIT_BY },
  };
}

/* ---------------- 几何 ---------------- */

const HEADER_H = 396;
const SECTION_H = 96;
/** 一行的高度 —— **两列**:左边文字(片名 / 英文名 / 红黑数),右边一块**专门的贴纸区**。
 *  ⚠ 导出给单测用:高度是绘制的自变量,写死数字的断言会在改版式时静默失效。 */
export const ROW_H = 104;
/** 三榜的空档(「我贴过的」那一节之前留白多一点) */
const BLOCK_GAP = 32;
/** 右侧贴纸区:宽度 / 高度 / 相对行顶的上边距 —— 行高 104 减去上下各 8
 *  (⚠ 宽度是从文字列手里让出来的:片名要截断的长度直接由它决定) */
const FIELD_W = 360;
const FIELD_H = 88;
const FIELD_TOP = 8;
/** 文字列与贴纸区之间的最小间距 */
const COL_GAP = 28;
/** 贴纸区里一枚贴纸的边长 —— 比卡片上那枚(`sticker-sprite.ts::STICKER_SIZE`)小得多:
 *  这里的行高只有 104,一行还要塞下别的字。
 *  ⚠ 它是**独立**的尺寸口径(不跟 `STICKER_SIZE` 联动),所以 `sticker-glyph.ts::ICON_RATIO`
 *    一变,这张图上的中心图标也会跟着变(14px 贴上从 7.7px 缩到 6.44px)——见那边的说明。
 *  ⚠ 它只是**尺寸**,形状仍然是 `sticker-shape.ts` 那一份(经 `shapePath(shape, size)` 等比换算)。 */
const FIELD_STICKER = 14;

/** 行内海报缩略图 —— 与「看片计划海报」的行内缩略图同一视觉语言(左图右文)。
 *  尺寸跟着**本图的行高**走:高与右侧贴纸区齐(`FIELD_H`),宽按海报常见的 2:3 取整。
 *  ⚠ 这是**独立**的尺寸口径,不与 `poster.ts` 的 `THUMB_W` / `THUMB_H` 联动 —— 两张图的行高本就
 *    不同(那边 168、这边 104),强行共用只会两边都不对。 */
const THUMB_W = 59;
const THUMB_H = FIELD_H;
const THUMB_R = 10;
/** 行内海报与「名次 / 我贴的那一色」列之间的间距 */
const THUMB_GAP = 18;
/** 名次 / 色标列的宽度 —— 文字统一从它右边(`TITLE_X`)起排 */
const MARK_W = 64;
/** 名次 / 色标起点(行内海报右侧) */
const MARK_X = PAD + THUMB_W + THUMB_GAP;
/** 片名 / 英文名 / 红黑数的起点 */
const TITLE_X = MARK_X + MARK_W;

/** 分享图总高(逻辑像素,含上下品牌红条)—— 行数决定高度,故必须与 `drawRbPoster` 同源。
 *  ⚠ 两处各算一份必然出现「算出来 3000 高、实际画了 3200」,而画布是按它设的 →
 *    多出来的内容**被裁掉且不报错**(最难查的一类),所以只写这一个函数。 */
export function rbPosterHeight(model: RbPosterModel): number {
  let h = ACCENT_H + HEADER_H;
  for (const b of model.boards) h += BLOCK_GAP + SECTION_H + b.rows.length * ROW_H;
  if (model.myRows.length) h += BLOCK_GAP + SECTION_H + model.myRows.length * ROW_H;
  return h + FOOTER_H + ACCENT_H;
}

/* ---------------- 绘制 ---------------- */

/** 「红 N · 黑 N」—— 分段上色,故逐段画(整串一个颜色就丢了红黑的可读性)。 */
function drawCounts(ctx: CanvasRenderingContext2D, row: RbPosterRow, x: number, baseline: number): void {
  ctx.font = font(24, 600);
  const segs: Array<[string, string]> = [
    ["红 ", C.muted],
    [`${row.red}`, C.red2],
    [" · 黑 ", C.muted],
    [`${row.black}`, C.ink2],
  ];
  let cx = x;
  for (const [text, color] of segs) {
    ctx.fillStyle = color;
    ctx.fillText(text, cx, baseline);
    cx += ctx.measureText(text).width;
  }
}

/* ---------------- 贴纸的形状与微图标(与页面四条渲染路径同源,2026-09-29) ---------------- */

/** 轮廓 `Path2D` 缓存。一行里几十枚贴纸各要一条路径,而同形状同尺寸的只有那么几种 ——
 *  按 `形状@尺寸` 存一次就够。
 *  ⚠ 尺寸必须显式传:形状的**唯一来源是 32 设计盒**,海报这边是 14 / 24,
 *    一律靠 `shapePath(shape, size)` 等比换算 —— 不要为小尺寸另描一份路径。 */
const bodyCache = new Map<string, Path2D>();

function stickerBody(shape: StickerShape, size: number): Path2D {
  const key = `${shape}@${size}`;
  const hit = bodyCache.get(key);
  if (hit) return hit;
  const built = new Path2D(shapePath(shape, size));
  bodyCache.set(key, built);
  return built;
}

/** 微图标 `Path2D` 缓存(图形本身与尺寸无关,缩放交给绘制时的 `ctx.scale`)。 */
const iconCache = new Map<StickerGlyph, Path2D>();

function stickerIcon(glyph: StickerGlyph): Path2D {
  const hit = iconCache.get(glyph);
  if (hit) return hit;
  const built = new Path2D(glyphPath(glyph));
  iconCache.set(glyph, built);
  return built;
}

/** 把微图标印在**已经平移到贴纸左上角**的坐标系里(那一格是 `0..size`)。
 *  ⚠ 走 `ctx.scale` 而不是重算路径:图形只有 24 盒那一份,缩放是它唯一的尺寸口径。
 *  ⚠ 落点必须走 `glyphPlacement`,**不能**只平移到中心再 `scale` —— 那是绕原点缩的,
 *    会把图案推到右下角(2026-09-29 踩过,见 `sticker-glyph.ts::glyphPlacement`)。 */
function drawStickerIcon(
  ctx: CanvasRenderingContext2D,
  glyph: StickerGlyph,
  size: number,
  color: string,
): void {
  const spot = glyphPlacement(size);
  ctx.save();
  ctx.translate(spot.x, spot.y);
  ctx.scale(spot.scale, spot.scale);
  ctx.fillStyle = color;
  ctx.fill(stickerIcon(glyph));
  ctx.restore();
}

/** **专门的贴纸区**(右侧那一列):把这一行的全部票摊在一块矩形里 —— 数字回答「多少」,
 *  这里回答「长什么样」。
 *
 *  为什么是「一块区」而不是「一条横带」:这是页面上卡片的版式(`.rb-card` = 左文字 + 右画布),
 *  分享图沿用同一套视觉语言,读的人不用重新学。而且横带只有 32px 高,纵坐标被压扁成一涂;
 *  这块 420×80 的区里,上下也有落点差异,才像「撒上去的贴纸」。
 *
 *  落点与歪斜**逐字复用卡片画布那套**(`spotOf` / `tiltOf`,由 id 确定性推导),「群点 + 我那一枚」
 *  的组成也同源(`othersOf` + 我那一枚追加在末尾),所以同一部片在分享图与卡片上摊出来的是同一堆贴纸。
 *
 *  ⚠ 数量**不打折**:票数几枚就画几枚(用户 2026-09-22 口径)。超出边缘的按卡片同口径裁掉
 *    (`.rb-canvas { overflow: hidden }` ↔ 这里的 `clip()`)。
 */
function drawField(ctx: CanvasRenderingContext2D, row: RbPosterRow, x: number, top: number): void {
  if (!row.stickers.length) return;
  // 一小块「地」:与卡片画布同色,让贴纸堆读成一个区域而不是浮在纸上
  ctx.fillStyle = C.card;
  roundRectPath(ctx, x, top, FIELD_W, FIELD_H, 10);
  ctx.fill();
  ctx.save();
  roundRectPath(ctx, x, top, FIELD_W, FIELD_H, 10);
  ctx.clip();
  const half = FIELD_STICKER / 2;
  row.stickers.forEach((s, i) => {
    // 形状与微图标**由 id 确定性推导** —— 与卡片画布 / 弹层 / 页面那枚共用同一套函数,
    // 所以同一部片在分享图与页面上摊出来的是**同一堆贴纸**(连轮廓都一致)。
    const body = stickerBody(skinSpec(s.skin).shape, FIELD_STICKER);
    ctx.save();
    // ⚠ 相对坐标映射到**去掉一枚贴纸之后**的范围:这块区只有 88px,照搬「中心 = posY × 高」
    //   会让上下沿的贴纸被切平(一排平顶);收进区内之后,`clip()` 只剩兜底。
    ctx.translate(x + half + s.posX * (FIELD_W - FIELD_STICKER), top + half + s.posY * (FIELD_H - FIELD_STICKER));
    ctx.rotate((s.tilt * Math.PI) / 180);
    ctx.translate(-half, -half);
    ctx.fillStyle = s.type === "red" ? C.red : C.stickerBlack;
    ctx.fill(body);
    // 材质与页面同源（同一份配方）；⚠ 分享图恒为深底，所以材质的白/黑颗粒在这里仍然成立
    paintMaterial(ctx, skinSpec(s.skin).material, body, FIELD_STICKER);
    if (s.type === "black") {
      // 深底上的黑贴纸要靠一圈亮边才认得出(理由同 `poster-brush.ts::COLORS.stickerBlack`)
      ctx.strokeStyle = C.muted;
      ctx.lineWidth = 0.8;
      ctx.stroke(body);
    }
    if (i === row.mineIndex) {
      // 我那一枚:一圈琥珀描边 —— 与「我贴过的」那一节左侧的色标同一个含义(这是我的票)。
      // ⚠ 2026-10-08(用户「有一些贴纸有白底,导致分享出来不好看」):原本是 `C.ink`(近白),
      //   深底海报上那圈白被读成「这枚贴纸自带白底」,而不是「这是我贴的」。改用海报自己的
      //   强调色 `note`(琥珀):红贴 / 黑贴上都够对比,又不会被读成白底。
      //   ⚠ 仍然**不是**「去掉标记」—— 用户 2026-09-23 明确要求自己那枚始终找得到
      //   (页面那圈常驻纸白边就是为它加的),去掉等于丢信息,不是修缺陷。
      ctx.strokeStyle = C.note;
      ctx.lineWidth = 1.2;
      ctx.stroke(body);
    }
    // 中心微图标:与页面上是同一族图形(同样由款决定),墨色用深底海报专属的那一档。
    // ⚠ 2026-10-05：金棕榈下线后不再有「恒为金」的那一款，墨色只剩 `C.stickerInk` 一档。
    // ⚠ 2026-10-08:**先裁到轮廓内再印**,与 `sticker-sprite.ts` 的第 ⑤ 步同一手法 ——
    //   胶片残片那种窄条比图标矮,不裁的话图标会从贴纸两侧探出去(真机上就是两撮白边)。
    ctx.save();
    ctx.clip(body);
    drawStickerIcon(ctx, skinSpec(s.skin).glyph, FIELD_STICKER, C.stickerInk);
    ctx.restore();
    ctx.restore();
  });
  ctx.restore();
}

/** **行内海报缩略图**(最左那一列):目录里有图就圆角裁切画上,缺图走中性占位块 + 居中片名首字。
 *
 *  ⚠ 与「看片计划海报」同一条来源(`FilmNode.poster`)、同一份加载语义
 *    (`poster-brush.ts::loadPosterImages`,失败即跳过),所以同一部片在两图上是同款缩略图。
 *  ⚠ 占位块**不留空洞**但也不写放映代码:红黑榜的行里没有 CODE 这个概念 —— 一个纯色空块读起来
 *    像 bug,片名首字足以认出是哪一部(与行程图用 CODE 占位是同一个目的)。
 *  ⚠ 同源图片不会污染画布,`toBlob` 依旧可用。 */
function drawThumb(
  ctx: CanvasRenderingContext2D,
  row: RbPosterRow,
  top: number,
  images: ReadonlyMap<string, HTMLImageElement>,
): void {
  // 垂直居中于本行(与右侧贴纸区同一条对齐:行高 104 − 图高 88 = 上下各 8)
  const y = top + (ROW_H - THUMB_H) / 2;
  const img = row.poster ? images.get(row.poster) : undefined;
  if (img) {
    ctx.save();
    roundRectPath(ctx, PAD, y, THUMB_W, THUMB_H, THUMB_R);
    ctx.clip();
    ctx.drawImage(img, PAD, y, THUMB_W, THUMB_H);
    ctx.restore();
    return;
  }
  ctx.fillStyle = C.card;
  roundRectPath(ctx, PAD, y, THUMB_W, THUMB_H, THUMB_R);
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.stroke();
  const head = row.title.trim().charAt(0);
  if (head) {
    ctx.font = font(24, 700);
    ctx.fillStyle = C.muted;
    ctx.textAlign = "center";
    ctx.fillText(head, PAD + THUMB_W / 2, y + THUMB_H / 2 + 8);
    ctx.textAlign = "left";
  }
}

/** 一行(**三列**)——左列:**行内海报**;中列:名次 / 我贴的那一色 + 片名(中英)+ 红黑数;右列:**贴纸区**。
 *  版式与页面卡片同源(`.rb-card` = 左文字 + 右画布),读的人不用重新学一套。 */
function drawRow(
  ctx: CanvasRenderingContext2D,
  row: RbPosterRow,
  rank: number,
  top: number,
  withMine: boolean,
  images: ReadonlyMap<string, HTMLImageElement>,
): void {
  // 文字列的右边界 = 贴纸区左边再让出 COL_GAP(片名截断长度由它决定)
  const textRight = POSTER_W - PAD - FIELD_W - COL_GAP;
  const textBase = top + 38;

  // 左侧标记:榜内是名次;「我贴过的」那一节换成我贴的那一色小贴纸(用户口径)
  if (withMine && row.mine) {
    const size = 24;
    const isRed = row.mine === "red";
    // 这一枚就是「我贴的那一张」的缩略:直接拿它在贴纸区里的那一枚来推形状与图标,
    // 而不是另起一个 id —— 否则同一个意思会在这张图上出现两种轮廓。
    const mineSticker = row.mineIndex >= 0 ? row.stickers[row.mineIndex] : null;
    // 没有那一枚时用**契约层的兜底款常量**（`FALLBACK_SKIN`）—— 不许在这里写死某个款名：
    // 2026-09-30 换款时这里正是写着 `"torn"`，而那一款被下线了，于是分享图上会画出一个
    // 白名单里已经不存在的款（不报错，只是画错）。兜底款只允许有一处表述。
    const mineSkin: StickerSkin = mineSticker?.skin ?? FALLBACK_SKIN;
    const body = stickerBody(skinSpec(mineSkin).shape, size);
    ctx.save();
    // 与片名那一行**视觉居中对齐**(基线往上约 9px 是字身中心,而不是整行居中)
    ctx.translate(MARK_X, textBase - 9 - size / 2);
    ctx.fillStyle = isRed ? C.red : C.stickerBlack;
    ctx.fill(body);
    if (!isRed) {
      // 深底上的黑贴纸必须靠一圈亮边才认得出(见 `poster-brush.ts::COLORS.stickerBlack`)
      ctx.strokeStyle = C.ink2;
      ctx.lineWidth = 1.5;
      ctx.stroke(body);
    }
    if (mineSticker) {
      // ⚠ 同样**先裁到轮廓内**再印图标(理由见 `drawField` 里那段):窄条轮廓比图标矮,
      //   不裁的话图标会从贴纸两侧探出去
      ctx.save();
      ctx.clip(body);
      drawStickerIcon(ctx, skinSpec(mineSkin).glyph, size, C.stickerInk);
      ctx.restore();
    }
    ctx.restore();
  } else {
    ctx.font = font(28, 700);
    ctx.fillStyle = rank <= 3 ? C.red2 : C.muted;
    ctx.fillText(`${rank}`.padStart(2, "0"), MARK_X, textBase);
  }

  const titleX = TITLE_X;
  const titleW = textRight - titleX;
  ctx.font = font(29, 600);
  ctx.fillStyle = C.ink;
  ctx.fillText(fitText(ctx, row.title, titleW), titleX, textBase);
  if (row.en) {
    ctx.font = font(20, 400);
    ctx.fillStyle = C.muted;
    ctx.fillText(fitText(ctx, row.en, titleW), titleX, textBase + 26);
  }
  // 红黑数落在第三行:右列让出了 360px,再挤在片名右边就会把片名压短
  drawCounts(ctx, row, titleX, textBase + 54);

  drawThumb(ctx, row, top, images);
  drawField(ctx, row, POSTER_W - PAD - FIELD_W, top + FIELD_TOP);
}

/** 分节头:左侧一小段品牌红竖条 + 标题 + 口径说明。 */
function drawSection(
  ctx: CanvasRenderingContext2D,
  label: string,
  hint: string,
  top: number,
): void {
  ctx.fillStyle = C.red;
  roundRectPath(ctx, PAD, top + 22, 6, 30, 3);
  ctx.fill();
  ctx.font = font(31, 700);
  ctx.fillStyle = C.ink;
  ctx.fillText(label, PAD + 20, top + 48);
  if (hint) {
    const w = ctx.measureText(label).width; // ⚠ 量完再换字体(字重变了测宽也会变)
    ctx.font = font(22, 500);
    ctx.fillStyle = C.muted;
    ctx.fillText(hint, PAD + 20 + w + 14, top + 48);
  }
}

/** 头部:小字届次 / 大标题 / 副标题 / 全站三格大字 / 我的一行小字。 */
function drawHeader(ctx: CanvasRenderingContext2D, model: RbPosterModel): void {
  const maxTextW = POSTER_W - PAD * 2;
  const y = ACCENT_H;

  ctx.font = font(19, 600);
  ctx.fillStyle = C.muted;
  ctx.fillText(model.eyebrow, PAD, y + 52);

  // 署名**头部也来一处**(2026-09-22 用户:「gaaiyeoi 和lcandy 的在头部也加一下就行」)——
  // 长图被截一半转发时,底部那行常常跟着丢掉;与届次同一行右对齐,不占额外高度。
  ctx.textAlign = "right";
  ctx.font = font(19, 500);
  ctx.fillStyle = C.muted;
  ctx.fillText(model.credit.by, POSTER_W - PAD, y + 52);
  ctx.textAlign = "left";

  ctx.font = font(56, 700);
  ctx.fillStyle = C.ink;
  ctx.fillText(fitText(ctx, model.title, maxTextW), PAD, y + 130);

  ctx.font = font(24, 500);
  ctx.fillStyle = C.ink2;
  ctx.fillText(fitText(ctx, model.subtitle, maxTextW), PAD, y + 180);

  drawRule(ctx, y + 214, maxTextW);

  // 全站三格:标签在上、数字在下(数字用大字号,一眼能读)
  const cols: Array<[string, number, string]> = [
    ["全站贴纸", model.site.total, C.ink],
    ["红", model.site.red, C.red2],
    ["黑", model.site.black, C.ink2],
  ];
  cols.forEach(([label, value, color], i) => {
    const x = PAD + i * 300;
    ctx.font = font(19, 600);
    ctx.fillStyle = C.muted;
    ctx.fillText(label, x, y + 262);
    ctx.font = font(46, 700);
    ctx.fillStyle = color;
    ctx.fillText(`${value}`, x, y + 320);
  });

  ctx.font = font(22, 500);
  ctx.fillStyle = C.muted;
  ctx.fillText(
    `我的：标记看过 ${model.mine.marked} 部 · 已贴 ${model.mine.placed} 枚 · 还能贴 ${model.mine.quota} 枚`,
    PAD,
    y + 366,
  );
}

/** 把模型画到给定画布上(画布尺寸由本函数按模型设好,调用方不必预先设)。
 *
 *  `images` = 已经加载好的影片海报(`url` → 图),由调用方先跑 `poster-brush.ts::loadPosterImages`;
 *  **加载失败 / 缺图的那些 url 不在表里** —— 绘制层对这一行走占位块,不报错、不留空洞。 */
export function drawRbPoster(
  canvas: HTMLCanvasElement,
  model: RbPosterModel,
  images: ReadonlyMap<string, HTMLImageElement>,
): void {
  const h = rbPosterHeight(model);
  const px = posterPixels(POSTER_W, h);
  // ⚠ 写 width/height 会**清空画布并重置 transform**,两者必须成对
  canvas.width = px.width;
  canvas.height = px.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // ⚠ 变换用「物理像素 / 逻辑尺寸」而不是那个浮点倍率:画布尺寸是取过整的,直接 `scale(倍率)`
  //    会在右下角留下一条不足 1px 的透明缝(深底图上就是一条亮线)
  ctx.scale(px.width / POSTER_W, px.height / h);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, POSTER_W, h);
  drawAccentBars(ctx, POSTER_W, h);

  drawHeader(ctx, model);

  let y = ACCENT_H + HEADER_H;
  for (const b of model.boards) {
    y += BLOCK_GAP;
    drawSection(ctx, b.label, b.hint, y);
    y += SECTION_H;
    b.rows.forEach((row, i) => {
      drawRow(ctx, row, i + 1, y, false, images);
      y += ROW_H;
    });
  }

  if (model.myRows.length) {
    y += BLOCK_GAP;
    drawSection(ctx, model.myTitle, model.myHint, y);
    y += SECTION_H;
    model.myRows.forEach((row, i) => {
      drawRow(ctx, row, i + 1, y, true, images);
      y += ROW_H;
    });
  }

  // 一节都没有:说清是「没勾」还是「真没票」(两者共用一句话会把用户误导到别处找原因)
  if (!model.boards.length && !model.myRows.length) {
    ctx.font = font(26, 500);
    ctx.fillStyle = C.muted;
    ctx.fillText(model.emptyText, PAD, y + 96);
  }

  // 页脚(绝对定位:内容再长也不会把它顶出画面)
  const footTop = h - ACCENT_H - FOOTER_H;
  drawRule(ctx, footTop + 24, POSTER_W - PAD * 2);
  ctx.textAlign = "center";
  ctx.font = font(24, 600);
  ctx.fillStyle = C.ink2;
  ctx.fillText(model.credit.site, POSTER_W / 2, footTop + 62);
  ctx.font = font(20, 400);
  ctx.fillStyle = C.muted;
  ctx.fillText(model.credit.by, POSTER_W / 2, footTop + 90);
  ctx.textAlign = "left";
}
