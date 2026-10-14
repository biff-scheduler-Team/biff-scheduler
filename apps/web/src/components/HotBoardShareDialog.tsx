/**
 * 「热门榜」分享图弹层（2026-10-14，`PLAN-20261014150805` 修订 2）。
 *
 * 热门榜的对外成品：单元（可选）+ 前 N 行（海报 + 片名 + 想看人数 + 口碑角标）+ 头尾开关。
 * 模型与绘制在 `hot-poster.ts`（纯逻辑、可单测）；这里只管弹层、选择、预览画布与复制 / 下载。
 *
 * ★ 与「红黑榜分享图」弹层（`RedBlackShareDialog.tsx`）同构但**刻意不复用同一个组件**：
 *   两者的选项语义不同（那边是「勾哪几节」，这边是「讲哪个单元」），而红黑榜那个组件已经
 *   带着「长图内容」那组勾选与它自己的快照口径 —— 硬塞两套选项只会让两边都难读。
 *
 * ⚠ a11y 不自造：`role=dialog` / aria-modal / focus trap / Esc 全部由 S2 的 `Dialog` 提供（§5）；
 *   只在打开时挂（理由与 `RedBlackShareDialog` 同一处：常驻会被 `DialogContainer` 当成当前弹层）。
 * ⚠ **焦点归还**由调用方（热门榜那个按钮）负责，见 `HotBoardPanel.tsx`。
 *
 * ★ **数据是快照，选项是活的**：打开那一刻的榜单行就是这张图的内容；换单元 / 条数 / 头尾
 *   只重组这张图，不再回去重新读数据（出图不该因为别人又点了几个「想看」而变样）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { download } from "../app/download";
import type { HotRow, HotUnit } from "../hot-board";
import { buildHotPosterModel, drawHotPoster, hotPosterHeight } from "../hot-poster";
import { loadPosterImages, POSTER_W, posterBlob, posterPixels } from "../poster-brush";
import { copyImageOrDownload } from "./share-image";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Checkbox,
  Content,
  Dialog,
  DialogContainer,
  Heading,
  Picker,
  PickerItem,
} from "./spectrum";

/** 「取前几名」的档位（2026-10-14 用户：「取前几名 改成 TOP3 TOP10」）。
 *
 *  ⚠ 原来是 前 5 / 前 8（3:4）/ 前 20（会变长）/ 全部 **四档**，现在收成两档。
 *  ⚠ **代价写清**：原先默认那档是 8 行 —— 它正好拼出 1080 × 1440（几何见
 *    `hot-poster.ts::HOT_POSTER_ROWS`）。这两档都不是 8，所以默认出图**不再是**那个
 *    3:4 竖版：TOP10 = 1080 × 1710（高一截）、TOP3 = 1080 × 765（一张小卡）。
 *    图高只跟行数走、**绝不补白**，这条口径没变（`hotPosterHeight`）。 */
const TOP_N_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "3", label: "TOP3" },
  { id: "10", label: "TOP10" },
];

/** 默认档 —— 两档里信息更全的那一支（TOP3 是给「只要三张脸」的短卡用的）。
 *  ⚠ **必须取上面某一档的 id**：`Picker` 的 `value` 匹配不到任何 `PickerItem` 时会显示空白，
 *    不会报错 —— 改档位时记得一起改这里。 */
const TOP_N_DEFAULT = 10;

/** 文件名里不能出现的字符（单元名可能带 `/`、`:`）—— 换成全角间隔号，别让下载静默失败。 */
function safeName(raw: string): string {
  return raw.replace(/[\\/:*?"<>|]/g, "·");
}

interface HotBoardShareDialogProps {
  /** **全部**行（未按单元切）—— 弹层里也能换单元，所以这里拿全量 */
  rows: readonly HotRow[];
  /** 单元分组（`hot-board.ts::groupByUnit` 的输出），用来给下拉提供选项与展示名 */
  units: readonly HotUnit[];
  /** 打开那一刻页面上选中的单元（空串 = 全部单元）—— 弹层以此为初始值，之后自己管 */
  unit: string;
  onDismiss: () => void;
}

export function HotBoardShareDialog({
  rows,
  units,
  unit,
  onDismiss,
}: HotBoardShareDialogProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  // 数据快照：只在挂载时取一次（见文件头）。`today` 同理 —— 出图日期不该随重渲染变。
  const [snapshot] = useState(() => ({ rows, units, today: new Date() }));
  const [unitId, setUnitId] = useState(unit);
  const [topN, setTopN] = useState(TOP_N_DEFAULT);
  const [showHeader, setShowHeader] = useState(true);
  const [showFooter, setShowFooter] = useState(true);

  const unitName = useMemo(
    () => snapshot.units.find((entry) => entry.id === unitId)?.name ?? "",
    [snapshot, unitId],
  );
  const shown = useMemo(
    // ⚠ `units.includes` 而不是 `unit ===`：与 `groupByUnit` / 面板筛选同一条口径，
    //   否则图上会比页面上少几部（联映块成员片，见 `util.ts::filmUnitKeys`）
    () => (unitId ? snapshot.rows.filter((row) => row.units.includes(unitId)) : snapshot.rows),
    [snapshot, unitId],
  );
  const model = useMemo(
    () =>
      buildHotPosterModel({
        rows: shown,
        unitName,
        topN,
        showHeader,
        showFooter,
        today: snapshot.today,
      }),
    [shown, unitName, topN, showHeader, showFooter, snapshot],
  );
  const hasContent = model.rows.length > 0;
  // 图里带了几张海报（缺图行不算）—— 画布手绘没有 DOM 可断言，与红黑榜弹层同一手法：
  // 给 E2E 一个「图里真的带了海报」的锚点。
  const posterCount = useMemo(
    () => model.rows.filter((row) => row.poster).length,
    [model],
  );
  // 尺寸随选项**当场**变（行数 / 头尾直接决定高度），与实际出图**同一处判断**（`posterPixels`）
  const px = posterPixels(POSTER_W, hotPosterHeight(model));
  const fileName = `BIFF2026-热门榜${unitName ? `-${safeName(unitName)}` : ""}.png`;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let canceled = false;
    // 重画前先清掉上一次的失败提示：换了选项之后它还挂着，会与这张**已经画好了**的图同时显示
    setError("");
    void (async () => {
      try {
        // 海报加载与另两张图共用同一份语义（`poster-brush.ts::loadPosterImages`）：
        // 缺图 / 失败都被静默跳过，绘制层对那一行改画占位块。
        const images = await loadPosterImages(
          model.rows.flatMap((row) => (row.poster ? [row.poster] : [])),
        );
        if (canceled) return;
        drawHotPoster(element, model, images);
        const next = await posterBlob(element);
        if (canceled) return;
        if (!next) throw new Error("empty canvas");
        setBlob(next);
      } catch {
        if (!canceled) setError("图片生成失败，请重新生成。");
      }
    })();
    return () => {
      canceled = true;
    };
  }, [model]);

  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="L">
        <Heading slot="title">热门榜分享图</Heading>
        <Content>
          {/* ⚠ 这里**不写**具体像素：宽高由 `hotPosterHeight` + `posterPixels` 算，
              下面那行 `.hb-share-size` 已经如实印了。写死一份迟早与它打架（§5）。 */}
          <p className="hb-share-lede">
            按<strong>想看人数</strong>排序，右侧是红黑口碑。取前 {topN} 名 ——
            行数决定图高（TOP3 是一张小卡，TOP10 高一截），不补白。下面是这张图的实际尺寸。
          </p>
          <div className="hb-share-scope">
            <Picker
              label="单元"
              value={unitId || "all"}
              onChange={(value) => {
                const next = String(value);
                setUnitId(next === "all" ? "" : next);
              }}
            >
              <PickerItem id="all">全部单元</PickerItem>
              {snapshot.units.map((entry) => (
                <PickerItem id={entry.id} key={entry.id}>
                  {`${entry.name}，${entry.rows.length} 部`}
                </PickerItem>
              ))}
            </Picker>
            <Picker
              label="取前几名"
              value={String(topN)}
              onChange={(value) => setTopN(Number(value))}
            >
              {TOP_N_CHOICES.map((choice) => (
                <PickerItem id={choice.id} key={choice.id}>
                  {choice.label}
                </PickerItem>
              ))}
            </Picker>
            <Checkbox isSelected={showHeader} onChange={setShowHeader}>
              画标题栏
            </Checkbox>
            <Checkbox isSelected={showFooter} onChange={setShowFooter}>
              画署名
            </Checkbox>
          </div>
          <p className="hb-share-size" role="status">
            这张图：
            <strong>
              {px.width} × {px.height}
            </strong>{" "}
            px · {Math.round(px.scale * 100) / 100}× 出图
            {blob ? ` · PNG 约 ${(blob.size / 1048576).toFixed(1)} MB` : ""}
          </p>
          {!blob && !error && <p role="status">正在生成图片…</p>}
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          {!hasContent && (
            <p role="status" className="hb-share-lede">
              这个范围里一部片都没有 —— 换个单元或换成「全部单元」。
            </p>
          )}
          <canvas
            ref={canvas}
            className="hb-share-preview"
            hidden={!blob}
            aria-label="热门榜分享图片预览"
            data-poster-count={posterCount}
          />
        </Content>
        <ButtonGroup>
          {blob && (
            <Button isDisabled={!hasContent} onPress={() => download(blob, fileName)}>
              下载 PNG 图片
            </Button>
          )}
          {blob && (
            <ActionButton
              isDisabled={!hasContent}
              onPress={() => void copyImageOrDownload(blob, fileName)}
            >
              复制图片
            </ActionButton>
          )}
          <Button variant="secondary" onPress={onDismiss}>
            关闭
          </Button>
        </ButtonGroup>
      </Dialog>
    </DialogContainer>
  );
}
