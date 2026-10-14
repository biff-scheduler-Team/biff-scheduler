/**
 * 「生成分享图」弹层(2026-09-22)。
 *
 * 红黑榜的对外成品:三个榜(总数 / 红 / 黑)各 TOP10 + **我贴过的全部**(不限条数)
 * + 每行左侧的**影片海报缩略图**(2026-10-08,对齐「看片计划海报」的行内缩略图)+ 底部署名。
 * 模型与绘制在 `redblack-poster.ts`(纯逻辑、可单测);这里只管弹层、勾选、预览画布与复制 / 下载。
 *
 * ⚠ a11y 不自造:`role=dialog` / aria-modal / focus trap / Esc 全部由 S2 的 `Dialog` 提供(§5);
 *   挂载手法照仓库既有路径 —— **只在打开时挂**,免得常驻的 `<Dialog>` 被 `DialogContainer`
 *   当成「当前弹层」一起显示(`SettingsDialog::ClearDialog` 的注释里踩过这个坑)。
 * ⚠ **焦点归还**由调用方(红黑榜页面上那个按钮)负责,见 `RedBlackPage.tsx`。
 *
 * ★ **数据是快照,勾选是活的**(2026-09-22):
 *   · 快照 —— 弹层打开那一刻的影片 / 票数 / 我的贴纸就是这张图的内容,之后页面再重拉票数也不影响;
 *   · 勾选 —— 「有的人不想所有的榜单都分享」,所以每一节都能单独勾掉,换勾选只重组这张图。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { FilmNode } from "../app/model";
import { download } from "../app/download";
import { loadPosterImages, POSTER_W, posterBlob, posterPixels } from "../poster-brush";
import {
  allSections,
  buildRbPosterModel,
  drawRbPoster,
  POSTER_SECTIONS,
  posterUnitOptions,
  rbPosterHeight,
  TOP_N,
  type RbPosterSection,
} from "../redblack-poster";
import type {
  CrowdCounts,
  FilmSkinCounts,
  StickerBoard,
  SyncedStickerFace,
} from "../redblack";
import { copyImageOrDownload } from "./share-image";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Checkbox,
  CheckboxGroup,
  Content,
  Dialog,
  DialogContainer,
  Heading,
  Picker,
  PickerItem,
} from "./spectrum";

const FILE_NAME = "BIFF2026-红黑榜.png";

/** 「每榜取前几名」的档位。`0` = **全部**（不截断）—— 小单元里选「5」比在 10 行里找更省事，
 *  而大单元里想全列（Icons 有 20 部有票）时也只有这一档做得到。 */
const TOP_N_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "5", label: "前 5" },
  { id: "10", label: "前 10" },
  { id: "20", label: "前 20" },
  { id: "0", label: "全部" },
];

interface RedBlackShareDialogProps {
  films: readonly FilmNode[];
  crowd: CrowdCounts;
  /** 影片 key → 该片**按款**票数（2026-09-29，含我）。缺席 = 没有款数据 → 群点按 id 兜底。
   *  ⚠ 这里给的是**全量**（不是只有当前榜单那几部）：分享图要画整份影片库，
   *    与 `crowd` 给 `reconciledCrowd` 而不是 `filmCounts` 是同一条理由。 */
  skins?: FilmSkinCounts;
  /** 影片 key → **服务端已确认**的我那一枚（色 + 款）—— 海报扣「按款分布」时的基准。
   *  ⚠ 与卡片同源（`RedBlackPage` 传同一份 `syncedFaces`），**不是**本地 board：
   *    换款还没上报落地时拿本地款去扣会把别人的那一枚扣掉（见 `redblack.ts::othersSkins`）。 */
  syncedFaces?: ReadonlyMap<string, SyncedStickerFace>;
  board: StickerBoard;
  /** 与页面 hero 同一份数字(传进来而不是重算 —— 图里的数必须与页面上看到的一字不差) */
  site: { total: number; red: number; black: number };
  /** 评分先验（全站红占比）—— 页面那份，与卡片右上角评分**同一个数**
   *  （口径见 `redblack.ts::priorOf` / `redblack-poster.ts::RbPosterInput.priorRate`） */
  priorRate: number;
  /** 我的（与页面 hero 那行小字同一份数字）。
   *  ⚠ 2026-10-14 两轮修订：`marked` / `quota` 随「标记看过」那道闸门撤掉，`unseen` 随上滑改
   *    纯跳过撤掉 —— 现在只剩 `placed`（我贴了几枚）。 */
  mine: { placed: number };
  onDismiss: () => void;
}

export function RedBlackShareDialog({
  films,
  crowd,
  skins,
  syncedFaces,
  board,
  site,
  priorRate,
  mine,
  onDismiss,
}: RedBlackShareDialogProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  // 数据快照:只在挂载时取一次(见文件头)。用 `useState` 的惰性初值而不是 `useMemo([])`,
  // 就是为了明确表达「这是个初值,不是派生量」。
  const [snapshot] = useState(() => ({
    films,
    crowd,
    skins,
    syncedFaces,
    board,
    site,
    priorRate,
    mine,
    today: new Date(),
  }));
  const [sections, setSections] = useState<Set<RbPosterSection>>(allSections);
  // 三个「范围」开关（2026-10-14，`PLAN-20261014150805`）：单元 / 每榜条数 / 头尾。
  // ⚠ 它们是**活**的（与 `sections` 同性质）：改了当场重组这张图，不必关掉弹层重开。
  const [unit, setUnit] = useState("");
  const [topN, setTopN] = useState(TOP_N);
  const [showHeader, setShowHeader] = useState(true);
  const [showFooter, setShowFooter] = useState(true);
  const unitOptions = useMemo(() => posterUnitOptions(snapshot.films), [snapshot]);
  const model = useMemo(
    () => buildRbPosterModel({ ...snapshot, sections, unit, topN, showHeader, showFooter }),
    [snapshot, sections, unit, topN, showHeader, showFooter],
  );
  // 「我贴过的」那一项的条数:0 部时勾它没有意义,直接置灰(而不是让用户勾出一节空白)。
  // ⚠ 直接用模型里的 `myCount` 而不是自己再数一遍 —— 它是**按当前单元切过**的那份
  //   （模型里 `placedFilms` 本来就来自切分后的候选集），自数一份必然在选单元后对不上。
  const placedCount = model.myCount;
  const hasContent = model.boards.length > 0 || model.myRows.length > 0;
  // 模型里带海报的行数(缺图行不算)。画布手绘没有 DOM 可断言,与 `PosterPreview` 的
  // `data-export-codes` 同一手法:给 E2E 一个「图里真的带了海报」的锚点。
  const posterCount = useMemo(
    () =>
      [...model.boards.flatMap((b) => b.rows), ...model.myRows].filter((row) => row.poster).length,
    [model],
  );
  // 出图尺寸随勾选**当场**变:几节几行直接决定高度,所以勾什么就报什么(用户 2026-09-22:
  // 「提示一下选择不同的分享模块后图片分别的大小是多少」)。尺寸与倍率都走 `posterPixels` ——
  // 与实际出图**同一处判断**(⚠ 倍率自 2026-10-08 起是连续值,直接乘会印出 `1566.0000000000002`)。
  const logicalHeight = rbPosterHeight(model);
  const px = posterPixels(POSTER_W, logicalHeight);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let canceled = false;
    // 重画前先清掉上一次的失败提示：换了勾选之后它还挂着，会与这张**已经画好了**的图同时显示
    setError("");
    void (async () => {
      try {
        // 海报缩略图与行程图共用同一份加载语义(`poster-brush.ts::loadPosterImages`):
        // 缺图 / 加载失败都会被静默跳过,绘制层对那一行改画占位块。
        const rows = [...model.boards.flatMap((b) => b.rows), ...model.myRows];
        const images = await loadPosterImages(
          rows.flatMap((row) => (row.poster ? [row.poster] : [])),
        );
        if (canceled) return;
        drawRbPoster(element, model, images);
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
        <Heading slot="title">红黑榜分享图</Heading>
        <Content>
          <p className="rb-share-lede">
            红榜 / 黑榜各取{topN > 0 ? `前 ${topN}` : "全部"}；我贴过的全部列出，不限条数。
            {unit
              ? " 只讲这一个单元 —— 连「我贴过的」也只列这个单元里的。"
              : ""}
          </p>
          {/* 三个「范围」开关（2026-10-14，用户「分享的时候可以选择需要哪个单元的就行」）：
              单元 / 每榜条数 / 要不要头尾。改任一项都**当场重组这张图**，与下面那组勾选同性质。 */}
          <div className="rb-share-scope">
            <Picker
              label="单元"
              value={unit || "all"}
              onChange={(value) => {
                const next = String(value);
                setUnit(next === "all" ? "" : next);
              }}
            >
              <PickerItem id="all">全部单元</PickerItem>
              {unitOptions.map((option) => (
                <PickerItem id={option.id} key={option.id}>
                  {`${option.name}，${option.films} 部`}
                </PickerItem>
              ))}
            </Picker>
            <Picker
              label="每榜条数"
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
          {/* 每一节都能单独勾掉:榜单是「全站看法」,不是每个人都愿意全发出去 */}
          <CheckboxGroup
            label="长图内容"
            orientation="horizontal"
            value={[...sections]}
            onChange={(values) => setSections(new Set(values as RbPosterSection[]))}
          >
            {POSTER_SECTIONS.map((section) => (
              <Checkbox
                key={section.id}
                value={section.id}
                isDisabled={section.id === "mine" && placedCount === 0}
              >
                {section.id === "mine" ? `${section.label}（${placedCount} 部）` : section.label}
              </Checkbox>
            ))}
          </CheckboxGroup>
          {/* 尺寸随勾选当场变:节数 / 行数直接决定高度 —— 勾之前就能知道这张图多大 */}
          <p className="rb-share-size" role="status">
            这张长图：
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
            <p role="status" className="rb-share-lede">
              一节都没勾：图里只剩头部统计与署名，下载与复制已停用。
            </p>
          )}
          <canvas
            ref={canvas}
            className="rb-share-preview"
            hidden={!blob}
            aria-label="红黑榜分享图片预览"
            data-poster-count={posterCount}
          />
        </Content>
        <ButtonGroup>
          {blob && (
            <Button isDisabled={!hasContent} onPress={() => download(blob, FILE_NAME)}>
              下载 PNG 图片
            </Button>
          )}
          {blob && (
            <ActionButton
              isDisabled={!hasContent}
              onPress={() => void copyImageOrDownload(blob, FILE_NAME)}
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
