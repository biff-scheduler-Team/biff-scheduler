// 分享图片的**弹层外壳**:预览 + 复制到剪贴板 / 下载 PNG。
//
// 与 `poster.ts` 的分工:那边是模型 + 绘制(import 期不碰 DOM,可单测),
// 这边才是 DOM —— 故 `modal.ts`(import 期就挂 document 监听)只在这里 import。
//
// 为什么先弹层再生成:海报要加载 N 张影片缩略图,异步期间**先给回执**(「正在生成行程图…」),
// 生成完原地替换 —— 而不是点完按钮静默一两秒才弹出来(用户会以为没反应,再点一次)。

import type { Catalog } from "./types";
import { el } from "./util";
import { pickEntries, type PickRow } from "./ics";
import { store } from "./state";
import { openModal } from "./modal";
import { toast } from "./toast";
import { BTN_ABORT, BTN_PRIMARY, buttonEl } from "./ui";
import { buildPosterModel, drawPoster, loadPosterImages, posterBlob } from "./poster";

/** 下载文件名(中文可直接用,微信 / 相册都能识别)。 */
const POSTER_FILENAME = "BIFF2026-看片计划.png";

/** 复制 PNG 到剪贴板 —— 需要安全上下文 + `ClipboardItem`(Chrome / Safari 13.1+);
 *  任一不满足返回 false,由调用方降级成下载(不能静默什么都不做)。 */
async function copyImageBlob(blob: Blob): Promise<boolean> {
  try {
    const CI = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (!CI || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new CI({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 「分享图片(行程图)」的入口 —— 预览一张可复制 / 可下载的行程长图。
 *  `rows` 省略 = 全部已排场次(旧行为);导出弹层按**所选方案**传入,只画那一套(2026-09-12)。 */
export function openPosterModal(cat: Catalog, talkOf: (code: string) => boolean, rows?: PickRow[]): void {
  const model = buildPosterModel(cat, rows ?? pickEntries(store.picks, cat), store.mappings, talkOf);
  if (!model) {
    toast(rows ? "该方案里没有可导出的场次" : "还没有选片,先在网格里点选场次");
    return;
  }

  const body = el("div", "flex flex-col gap-[12px]");
  const stage = el("div", "text-muted text-13 py-10 text-center", "正在生成行程图…");
  body.appendChild(stage);
  openModal("分享图片", body, "lg");

  void (async () => {
    const urls = model.days
      .flatMap((d) => d.rows.map((r) => r.poster))
      .filter((u): u is string => Boolean(u));
    const images = await loadPosterImages(urls);

    const canvas = document.createElement("canvas");
    drawPoster(canvas, model, images);
    canvas.className = "w-full h-auto rounded-8 border border-line block bg-[var(--bg-raised)]";
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      `${model.festName} ${model.title}:共 ${model.count} 场 / ${model.films} 部`
    );
    stage.replaceWith(canvas);

    const blob = await posterBlob(canvas);
    // 提示靠左、操作靠右(全站对齐语言);`mr-auto` 让它在折行后仍贴左缘
    const hint = el(
      "span",
      "text-muted text-12 leading-[1.6] mr-auto max-w-[280px]",
      "长按 / 右键图片可保存;「复制图片」后可直接粘贴到微信"
    );
    const copy = buttonEl(BTN_PRIMARY, "复制图片");
    const save = buttonEl(BTN_ABORT, "下载 PNG");
    const actions = el("div", "flex items-center gap-[10px] flex-wrap");
    actions.append(hint, copy, save);
    body.appendChild(actions);

    copy.addEventListener("click", () => {
      void (async () => {
        if (!blob) {
          toast("图片生成失败,请改用「下载 PNG」");
          return;
        }
        if (await copyImageBlob(blob)) {
          toast("已复制行程图,粘贴到微信即可");
          return;
        }
        downloadBlob(blob, POSTER_FILENAME);
        toast("当前浏览器不支持复制图片,已改为下载");
      })();
    });

    save.addEventListener("click", () => {
      if (!blob) {
        toast("图片生成失败,请重试");
        return;
      }
      downloadBlob(blob, POSTER_FILENAME);
      toast("已下载行程图");
    });
  })();
}
