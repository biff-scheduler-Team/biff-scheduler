// 分享图片(行程图)—— 与「分享文案」(`share.ts`)/「.ics」(`ics.ts`)并列的第三个出口。
//
// ★ 为什么是 canvas 手绘,而不是 html2canvas / 截图:
//   ① **零依赖**:海报生成不引入额外运行时依赖(PWA 产物要小、要能离线);
//   ② **确定性**:截图会受应用主题(亮 / 暗)、抽屉宽度、滚动位置影响 ——
//      同一份行程在不同人手里出图不一样,而分享图是「对外的成品」,必须每次都长一个样;
//   ③ **重排而非缩放**:截图只能把屏幕缩小,而海报该做的是「按海报重排信息」——
//      左侧贴影片海报缩略图、日期分节、去掉一切界面控件。故这里手绘。
//
// ★ 分层(与 `backup.ts` / `backup-panel.ts` 同口径):
//   本文件 = **模型 + 几何 + 绘制**(import 期不碰 DOM,可在 node 单测直接导入);
//   弹层 / 剪贴板 / 下载 = `poster-panel.ts`(它才 import `modal.ts` —— 那个模块在 import 期就挂
//   `document` 监听,node 里跑不起来)。
//
// ★ 口径与网格 / 行程 / 分享文案同源,勿另起一套:
//   · 时间 = **有效结束**(`gv.ts::effEndMin`,含 / 弃映后谈按单场解析);
//   · 片名 = `util.ts::displayTitle`(英文名 · 中文名);
//   · 影院 = `legend.ts::venueShort`(短名);
//   · 排序 / 概要 = `share.ts::orderedPickRows` / `shareSummary`。

import type { Catalog, Mapping } from "./types";
import { dateInfo, displayTitle, filmInfoOf, fmtMinRangeMin, groupByDate, hmsToMin } from "./util";
import { effEndMin, gvTalkMin } from "./gv";
import { venueShort } from "./legend";
import type { PickRow } from "./ics";
import { gvMark, orderedPickRows, shareSummary } from "./share";

/* ---------------- 模型(纯数据,可单测) ---------------- */

/** 一场已排场次在海报上需要的全部文案(与 DOM 无关,便于断言口径)。 */
export interface PosterRow {
  code: string;
  /** 「10:00–12:20」(跨午夜印「次日 05:35」) */
  time: string;
  /** 英文名 · 中文名 */
  title: string;
  /** 影院短名 */
  venue: string;
  /** GV 标记,非 GV 场为空串 */
  gv: string;
  note: string;
  /** 海报图相对路径(目录命中且已下载才有;缺图走占位块) */
  poster?: string;
}

export interface PosterDay {
  label: string; // OCT 8
  weekday: string; // 周四
  count: number;
  rows: PosterRow[];
}

export interface PosterModel {
  /** 节展全名(标题上方那行小字;`schedule.json` 里可能很长,绘制时会自动收尾) */
  festName: string;
  /** 大标题 = 「2026 看片计划」——
   *  ⚠ **不能直接用节展全名**:2026 版 `festival.name` = "31st Busan International Film Festival",
   *  按 52px 排会直接冲出画面(实测出图被切掉半个 "202…")。全名交给上方小字那行。 */
  title: string;
  range: string; // OCT 6–OCT 15
  count: number; // 场次总数
  films: number; // 影片总数
  days: PosterDay[];
}

/** 已选场次 → 海报模型。空输入(无有效场次)返回 null,调用方据此给「还没有选片」提示。 */
export function buildPosterModel(
  cat: Catalog,
  entries: PickRow[],
  mappings: Map<string, Mapping>,
  talkOf: (code: string) => boolean
): PosterModel | null {
  const rows = orderedPickRows(cat, entries);
  const sum = shareSummary(cat, rows);
  if (!sum) return null;

  const fest = cat.schedule.festival;
  const days: PosterDay[] = [];
  for (const [iso, group] of groupByDate(rows, (r) => r.s.date)) {
    const { label, weekday } = dateInfo(iso);
    days.push({
      label,
      weekday,
      count: group.length,
      rows: group.map(({ e, s }) => {
        // 映后谈取舍与网格 / .ics / 分享文案同一解析:有谈段才问 talkOf,谈段为 0 的场无开关
        const talk = gvTalkMin(s);
        const talkOn = talk > 0 ? talkOf(e.code) : true;
        const map = mappings.get(e.code);
        const v = cat.venueById.get(s.venue_id);
        return {
          code: e.code,
          time: fmtMinRangeMin(hmsToMin(s.start_time), effEndMin(s, talkOn)),
          title: displayTitle(s, map?.title_cn),
          venue: v ? venueShort(v) : s.venue_display,
          gv: gvMark(s, talkOn),
          note: e.note,
          poster: filmInfoOf(cat, s, map).cats[0]?.poster,
        };
      }),
    });
  }
  return {
    festName: fest.name,
    title: `${fest.year} 看片计划`,
    range: sum.range,
    count: sum.count,
    films: sum.films,
    days,
  };
}

/* ---------------- 几何 / 配色 ---------------- */

/** 逻辑宽度 —— 分享图按 1080 宽出图(微信 / 相册长图的常规宽度),再按 `SCALE` 超采样取像素。 */
export const POSTER_W = 1080;
/** 超采样倍率:逻辑 1px = 2 物理像素(视网膜屏上文字与描边不糊)。 */
const SCALE = 2;
/** 长图退档阈值(逻辑高)—— 画布**单边上限 32767**,而一行 168px:
 *  190 场 ≈ 32000 逻辑高,2× 就是 64000 → `toBlob` 静默出空图(不抛错,最难查)。
 *  超过本阈值就回 1×(约可撑到 190 场;再多的行程本来也不该走分享图,该用分享文案)。 */
const SCALE_DOWN_H = 8000;

const PAD = 56; // 左右内距
const ACCENT_H = 10; // 顶部 / 底部品牌红条
const HEADER_H = 232;
const DAY_HEAD_H = 76;
const DAY_GAP = 24;
const ROW_H = 168; // 无备注的一行(海报缩略图 144 高 + 上下各 12)
const ROW_H_NOTE = 200;
const THUMB_W = 96;
const THUMB_H = 144;
const THUMB_R = 10;
const FOOTER_H = 104;

/** 海报**固定深色** —— 不跟随应用主题:分享图是对外成品,深底 + 品牌红在聊天流里辨识度最高,
 *  且亮 / 暗两种应用外观下出图一致(否则同一份行程在不同人手里长得不一样)。 */
const C = {
  bg: "#101013",
  card: "#1a1a21",
  line: "#2b2b33",
  ink: "#f4f4f6",
  ink2: "#c7c7d0",
  muted: "#8a8a95",
  red: "#ce1e36",
  red2: "#e8455c",
  note: "#e2b667",
  gvBg: "#2b2b35",
  gvInk: "#f2a6b2",
};

/** 字体栈与页面同族(中文优先 PingFang / 微软雅黑,拉丁走 system-ui)。 */
const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif';

function font(size: number, weight: number): string {
  return `${weight} ${size}px ${FONT}`;
}

/** 海报总高(逻辑像素,含上下品牌红条)—— 行高随「有无备注」变,故必须由模型算。 */
export function posterHeight(model: PosterModel): number {
  let h = ACCENT_H + HEADER_H;
  for (const d of model.days) {
    h += DAY_HEAD_H;
    for (const r of d.rows) h += r.note ? ROW_H_NOTE : ROW_H;
    h += DAY_GAP;
  }
  return h + FOOTER_H + ACCENT_H;
}

/* ---------------- 绘制 ---------------- */

/** 圆角矩形路径 —— 手写 `arcTo` 而不依赖 `ctx.roundRect`(兼容性最稳,行为完全确定)。 */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 字距加宽的文本 —— canvas 的 `letterSpacing` 兼容性一般,逐字画最稳。 */
function drawTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number
): void {
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + tracking;
  }
}

/** 单行截断:超出 `maxW` 时尾部补「…」(画布没有 CSS 的 text-overflow)。 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let out = "";
  for (const ch of text) {
    if (ctx.measureText(out + ch + "…").width > maxW) break;
    out += ch;
  }
  return out ? `${out}…` : "…";
}

/** 加宽字距那行的测宽 —— 必须把 `tracking` 一起算进去,否则「量着放得下、画出来溢出」。 */
function trackedWidth(ctx: CanvasRenderingContext2D, text: string, tracking: number): number {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + tracking;
  return Math.max(w - tracking, 0);
}

/** 加宽字距那行的截断(同 `fitText`,但按带字距的宽度判)。 */
function fitTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  tracking: number
): string {
  if (trackedWidth(ctx, text, tracking) <= maxW) return text;
  let out = "";
  for (const ch of text) {
    if (trackedWidth(ctx, out + ch + "…", tracking) > maxW) break;
    out += ch;
  }
  return out ? `${out}…` : "…";
}

/** GV 标记块(时间右侧) */
function drawGvChip(ctx: CanvasRenderingContext2D, text: string, x: number, baseline: number): void {
  ctx.font = font(18, 700);
  const w = ctx.measureText(text).width + 20;
  ctx.fillStyle = C.gvBg;
  roundRectPath(ctx, x, baseline - 20, w, 28, 6);
  ctx.fill();
  ctx.fillStyle = C.gvInk;
  ctx.fillText(text, x + 10, baseline);
}

/** 一行场次:左海报缩略图 + 右侧三行(时间 / 片名 / 影院 · CODE),有备注时多一行。 */
function drawRow(
  ctx: CanvasRenderingContext2D,
  r: PosterRow,
  top: number,
  rowH: number,
  images: Map<string, HTMLImageElement>
): void {
  const thumbY = top + (rowH - THUMB_H) / 2;
  const img = r.poster ? images.get(r.poster) : undefined;
  if (img) {
    ctx.save();
    roundRectPath(ctx, PAD, thumbY, THUMB_W, THUMB_H, THUMB_R);
    ctx.clip();
    ctx.drawImage(img, PAD, thumbY, THUMB_W, THUMB_H);
    ctx.restore();
  } else {
    // 缺海报是常态(250 部里 174 部有):留一个中性占位块 + CODE,不留空洞
    ctx.fillStyle = C.card;
    roundRectPath(ctx, PAD, thumbY, THUMB_W, THUMB_H, THUMB_R);
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = font(20, 700);
    ctx.fillStyle = C.muted;
    ctx.textAlign = "center";
    ctx.fillText(r.code, PAD + THUMB_W / 2, thumbY + THUMB_H / 2 + 7);
    ctx.textAlign = "left";
  }

  const tx = PAD + THUMB_W + 26;
  const maxW = POSTER_W - PAD - tx;
  let ty = top + 46;

  ctx.font = font(27, 700);
  ctx.fillStyle = C.ink;
  ctx.fillText(r.time, tx, ty);
  if (r.gv) drawGvChip(ctx, r.gv, tx + ctx.measureText(r.time).width + 14, ty);

  ty += 42;
  ctx.font = font(29, 600);
  ctx.fillStyle = C.ink;
  ctx.fillText(fitText(ctx, r.title, maxW), tx, ty);

  ty += 36;
  ctx.font = font(22, 400);
  ctx.fillStyle = C.ink2;
  ctx.fillText(fitText(ctx, `${r.venue} · ${r.code}`, maxW), tx, ty);

  if (r.note) {
    ty += 32;
    ctx.font = font(21, 400);
    ctx.fillStyle = C.note;
    ctx.fillText(fitText(ctx, `备注 ${r.note}`, maxW), tx, ty);
  }
}

/** 把模型画到给定画布上(画布尺寸由本函数按模型设好,调用方不必预先设)。 */
export function drawPoster(
  canvas: HTMLCanvasElement,
  model: PosterModel,
  images: Map<string, HTMLImageElement>
): void {
  const h = posterHeight(model);
  const scale = h > SCALE_DOWN_H ? 1 : SCALE;
  canvas.width = POSTER_W * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(scale, scale);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // 底色 + 上下品牌红条(渐变同顶栏按钮)
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, POSTER_W, h);
  const bar = ctx.createLinearGradient(0, 0, POSTER_W, 0);
  bar.addColorStop(0, C.red);
  bar.addColorStop(1, C.red2);
  ctx.fillStyle = bar;
  ctx.fillRect(0, 0, POSTER_W, ACCENT_H);
  ctx.fillRect(0, h - ACCENT_H, POSTER_W, ACCENT_H);

  // ---- 头部 ----
  const maxTextW = POSTER_W - PAD * 2;
  let y = ACCENT_H;
  ctx.font = font(19, 600);
  ctx.fillStyle = C.muted;
  drawTracked(ctx, fitTracked(ctx, model.festName.toUpperCase(), maxTextW, 4), PAD, y + 58, 4);

  ctx.font = font(52, 700);
  ctx.fillStyle = C.ink;
  ctx.fillText(fitText(ctx, model.title, maxTextW), PAD, y + 128);

  ctx.font = font(25, 500);
  ctx.fillStyle = C.ink2;
  const head = `${model.range} · 共 `;
  ctx.fillText(head, PAD, y + 180);
  // ⚠ 先量再换字体:字重变了测宽也会变,先后顺序错了前后两段就会错位
  const headW = ctx.measureText(head).width;
  ctx.font = font(25, 700);
  ctx.fillStyle = C.red2;
  ctx.fillText(`${model.count} 场 / ${model.films} 部`, PAD + headW + 8, y + 180);

  y += HEADER_H;
  ctx.fillStyle = C.line;
  ctx.fillRect(PAD, y - 24, POSTER_W - PAD * 2, 1);

  // ---- 日期分节 + 场次 ----
  for (const d of model.days) {
    ctx.fillStyle = C.red;
    roundRectPath(ctx, PAD, y + 20, 6, 30, 3);
    ctx.fill();

    const dayText = `${d.label} ${d.weekday}`;
    ctx.font = font(31, 700);
    ctx.fillStyle = C.ink;
    ctx.fillText(dayText, PAD + 20, y + 46);
    const dayW = ctx.measureText(dayText).width; // 同上:量完再换字体
    ctx.font = font(22, 500);
    ctx.fillStyle = C.muted;
    ctx.fillText(`${d.count} 场`, PAD + 20 + dayW + 14, y + 46);
    y += DAY_HEAD_H;

    for (const r of d.rows) {
      const rowH = r.note ? ROW_H_NOTE : ROW_H;
      drawRow(ctx, r, y, rowH, images);
      y += rowH;
    }
    y += DAY_GAP;
  }

  // ---- 页脚(绝对定位:内容再长也不会把它顶出画面) ----
  const footTop = h - ACCENT_H - FOOTER_H;
  ctx.fillStyle = C.line;
  ctx.fillRect(PAD, footTop + 24, POSTER_W - PAD * 2, 1);
  ctx.font = font(20, 500);
  ctx.fillStyle = C.muted;
  ctx.fillText("排片数据来自 biff.kr 官方页面 · 仅作个人观影参考", PAD, footTop + 60);
  ctx.textAlign = "right";
  ctx.fillText("由 BIFF 排片工具生成", POSTER_W - PAD, footTop + 60);
  ctx.textAlign = "left";
}

/** 画布 → PNG Blob(`toBlob` 回调式,包一层 Promise)。 */
export function posterBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

/** 加载海报缩略图 —— **失败即静默跳过**(缺图走占位块,不能让一张图挂掉整张海报)。
 *  同源图片不会污染画布,`toBlob` 依旧可用。 */
export function loadPosterImages(urls: string[]): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>();
  const tasks = [...new Set(urls)].map(
    (u) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => {
          out.set(u, img);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = u;
      })
  );
  return Promise.all(tasks).then(() => out);
}
