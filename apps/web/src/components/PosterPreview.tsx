import { useEffect, useRef, useState } from "react";
import { ActionButton, Button, ToastQueue } from "./spectrum";
import {
  drawPoster,
  loadPosterImages,
  posterBlob,
  type PosterModel,
} from "../poster";
import { download } from "../app/download";

/** A preview owns one immutable plan snapshot and the canvas/blob produced for it. */
export function PosterPreview({
  generationId,
  model,
  onLoadingChange,
}: {
  generationId: number;
  model: PosterModel;
  onLoadingChange: (generationId: number, loading: boolean) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let canceled = false;
    const element = canvas.current;
    if (!element) return;
    onLoadingChange(generationId, true);
    void (async () => {
      try {
        const images = await loadPosterImages(
          model.days.flatMap((day) =>
            day.rows.flatMap((row) => (row.poster ? [row.poster] : [])),
          ),
        );
        if (canceled) return;
        drawPoster(element, model, images);
        const nextBlob = await posterBlob(element);
        if (canceled) return;
        if (!nextBlob) throw new Error("empty canvas");
        setBlob(nextBlob);
      } catch {
        if (!canceled) setError("图片生成失败，请重新生成。");
      } finally {
        if (!canceled) onLoadingChange(generationId, false);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [generationId, model, onLoadingChange]);

  const copyImage = async () => {
    if (!blob) return;
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
        throw new Error("clipboard unavailable");
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      ToastQueue.positive("图片已复制", { timeout: 5000 });
    } catch {
      download(blob, "BIFF2026-看片计划.png");
      ToastQueue.neutral("当前浏览器无法复制图片，已改为下载。", {
        timeout: 5000,
      });
    }
  };
  return (
    <section className="form-stack" aria-label="分享图片预览">
      {!blob && !error && <p role="status">正在生成行程图…</p>}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <canvas
        ref={canvas}
        className="poster-preview"
        hidden={!blob}
        aria-label="行程分享图片"
        data-export-codes={model.days
          .flatMap((d) => d.rows.map((r) => r.code))
          .join(",")}
      />
      {blob && (
        <div className="inline-actions">
          <Button onPress={() => download(blob, "BIFF2026-看片计划.png")}>
            下载 PNG 图片
          </Button>
          <ActionButton
            onPress={() => {
              void copyImage();
            }}
          >
            复制图片
          </ActionButton>
        </div>
      )}
    </section>
  );
}
