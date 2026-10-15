/**
 * 红黑榜「排行榜」弹层（2026-10-15，`PLAN-20261015153233`；2026-10-16 `PLAN-20261016000441` 起自己出图）。
 *
 * ★ 用户原话（第一版）：「红黑榜有直观的榜单吗 在快速投票旁边加一个榜单 简单展示红榜 黑榜 TOP50
 *   因为现在贴纸区 只需要显示影片的名称海报 以及红黑贴纸数 只需要样式参考分享图就行」。
 *
 * ★ 版式与配色**照着分享图那一行做**（`redblack-poster.ts` 的 `drawRow` / `drawSection` /
 *   `drawCounts`）：从左到右 **名次 → 行内海报 → 片名（中 / 英）→ 红 N · 黑 N**，
 *   深底 + 海报色、分节头是一根红竖条 —— 看过那张长图的人不用重新学一遍。
 *   ⚠ 2026-10-15（`PLAN-20261015161935`）用户看过第一版后的话：「排行样式应该参考红黑榜的分享样式」
 *     —— 第一版只借了**版式顺序**、配色走的是应用 token（白底），观感与那张图差得远。
 *   ⚠ 色值一律从 `COLORS` 注入（`POSTER_SKIN`），本文件与 `rank-board.css` 都不写死色值。
 *
 * ★ 两层分开：排序与门槛在 `redblack-rank.ts`（纯逻辑、可单测，且与分享图同一支），
 *   本文件只管取数 + 编排。⚠ 票数**由页面传进来**（`reconciledCrowd`，见 `RedBlackPage`）——
 *   自己再算一份的话，弹层上的数字会与同一屏里卡片上的数字对不上。
 *
 * ★ **出图（2026-10-16，`PLAN-20261016000441`）**：用户原话 ——
 *   「排行榜的没有复制图片的 点击分享后会跳到红黑榜的分享」「红黑榜的排行榜两个榜单需要两张图
 *   单独复制按钮吧」。于是本弹层**自己**往外发：点「生成图片」→ 红榜 / 黑榜**各一张**，
 *   每张各有自己的「下载 PNG 图片 / 复制图片」。
 *   ⚠ 这**不是**第二条出图实现：模型与绘制仍然是 `redblack-poster.ts` 那一份 ——
 *     两张图 = `buildRbPosterModel({ sections: 只留该榜, topN: RANK_LIMIT })` + `drawRbPoster`，
 *     同一个出图器换了个入参。（`PLAN-20261015170310` 当初否掉「弹层内嵌出图」的理由是
 *     「等于把模型 / 勾选 / 预览再实现一遍」——复用 `sections` 之后那条理由不成立了。）
 *   ⚠ 「点了才出图」与两个分享图弹层**同一口径**（用户「都要点击确认后再生成图片」）：打开不出图。
 *   ⚠ 出好的两张图**不再随票数刷新作废**（与分享图弹层那条「选项一改就作废」不同）：
 *     这里没有「选项」，而票数是活的 —— 中途作废只会把用户正要复制的那张抽走。它们是**快照**
 *     （同一份 `PLAN` 的「数据是快照」那一层，与分享图一样）。
 *   ⚠ 因此本文件现在**带上了** `redblack-poster.ts`（≈9KB gz）—— 它由 `RedBlackPage` **懒加载**
 *     （与分享图 / 讨论区 / 二维码同一处置）：进红黑榜的人多数不会点「排行榜」。
 *
 * ⚠ a11y 不自造：`role=dialog` / aria-modal / focus trap / Esc 全由 S2 的 `Dialog` 提供（§5）；
 *   **焦点归还**由调用方负责（那枚按钮的主人 `BoardPage` 才知道该还给谁，与「快速投票」同一手法）。
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { download } from "../app/download";
import type { FilmNode } from "../app/model";
import { COLORS, loadPosterImages, POSTER_W, posterBlob, posterPixels } from "../poster-brush";
import {
  buildRbPosterModel,
  drawRbPoster,
  rbPosterHeight,
  type RbPosterSection,
} from "../redblack-poster";
import type {
  CrowdCounts,
  FilmSkinCounts,
  SortMode,
  StickerBoard,
  SyncedStickerFace,
} from "../redblack";
import { buildRankRows, RANK_BOARDS, RANK_LIMIT } from "../redblack-rank";
import { copyImageOrDownload } from "./share-image";
import { ActionButton, Button, ButtonGroup, Content, Dialog, DialogContainer, Heading } from "./spectrum";
import "./rank-board.css";

/** 分享图那一套**固定深色**（`poster-brush.ts::COLORS`——分享图是对外成品，底色不随应用主题翻，
 *  理由见那里的注释）。这里把它注入成 CSS 变量，而不是在 `rank-board.css` 里再抄一份色值：
 *  同一含义只允许有一处定义，抄第二份就会在改调色板时静默分叉（§5）。 */
const POSTER_SKIN = {
  "--rbr-bg": COLORS.bg,
  "--rbr-card": COLORS.card,
  "--rbr-line": COLORS.line,
  "--rbr-ink": COLORS.ink,
  "--rbr-ink2": COLORS.ink2,
  "--rbr-muted": COLORS.muted,
  "--rbr-red": COLORS.red,
  "--rbr-red2": COLORS.red2,
} as CSSProperties;

/** 一张已经出好的图 —— 尺寸也一起存：出完图之后票数若又刷新，题注不能跟着变成另一个数
 *  （那会让它与画布上那张图**对不上**，而这两样东西是给人对照看的）。 */
interface RankShotImage {
  blob: Blob;
  width: number;
  height: number;
}

interface RedBlackRankDialogProps {
  /** 影片库（**全量**，与卡片栅格同一份）—— `buildRankRows` 内部再走 `boardFilms` 把它拆成成员片 */
  films: readonly FilmNode[];
  /** 以本地视角修正过的全站票数（与卡片 / hero / 分享图**同一份**，见 `RedBlackPage::reconciledCrowd`） */
  crowd: CrowdCounts;
  /** 评分先验（全站红占比）—— 排序里「同票数比评分」要用它，与卡片角标同一个数 */
  priorRate: number;
  /** 我贴过的（`RedBlackPage::board`）—— 出图时用它标出「我那一枚」的琥珀圈，
   *  也给群点扣掉我自己那一枚。⚠ 必须是**页面那一份**：自己再算一份会与卡片 / 分享图给出两套票数。 */
  board: StickerBoard;
  /** 影片 key → 该片**按款**票数（含我）。缺席 = 没有款数据 → 群点按 id 兜底（同 `RedBlackShareDialog`） */
  skins?: FilmSkinCounts;
  /** 影片 key → **服务端已确认**的我那一枚 —— 扣减基准，与卡片 / 分享图**同一份** */
  syncedFaces?: ReadonlyMap<string, SyncedStickerFace>;
  /** 页面 hero 那份「全站」统计（**传进来而不是重算**，图里与页面上才会是同一些数字） */
  site: { total: number; red: number; black: number };
  /** 页面 hero 那份「我的」统计（今天只有 `placed`） */
  mine: { placed: number };
  onDismiss: () => void;
}

export function RedBlackRankDialog({
  films,
  crowd,
  priorRate,
  board,
  skins,
  syncedFaces,
  site,
  mine,
  onDismiss,
}: RedBlackRankDialogProps) {
  // ⚠ 两榜**同一拍**算完（同一个 useMemo）：分成两个 useMemo 会让它们在票数刷新时错开一拍，
  //   而这一屏里两列是并排看的，「红榜已经更新、黑榜还是旧数」比两边都旧更刺眼。
  const boards = useMemo(
    () =>
      RANK_BOARDS
        // 该榜一票都没有 → **整列不渲染**（与分享图 `.filter(rows.length > 0)` 同一条：
        // 黑榜里挂一个空标题只会让人以为加载坏了）
        .map((entry) => ({ ...entry, rows: buildRankRows(films, crowd, entry.mode, priorRate) }))
        .filter((entry) => entry.rows.length > 0),
    [films, crowd, priorRate],
  );

  /** 出图日期 —— 与分享图同一条：**挂载时取一次**（不读时钟、不随重渲染变）。 */
  const [today] = useState(() => new Date());

  // 出图用的模型：**每榜一张**（见文件头）。⚠ 与上面那两列读的是同一份 `films` / `crowd` / `priorRate`，
  // 连门槛与排序都是同一支（`redblack-rank.ts` 与分享图本来就同源），所以图里的名次与列里的一字不差。
  const shots = useMemo(
    () =>
      RANK_BOARDS.map((entry) => {
        const model = buildRbPosterModel({
          films,
          crowd,
          board,
          skins,
          syncedFaces,
          site,
          mine,
          priorRate,
          today,
          // 只留这一榜：`sections` 是分享图既有的入参（勾掉哪节就不画哪节），这里只是把它收成一节。
          sections: new Set<RbPosterSection>([entry.mode]),
          // 条数取排行榜**自己的**口径（TOP50），不是分享图的默认档 —— 图要与这一屏的读数一致。
          topN: RANK_LIMIT,
        });
        const rows = model.boards[0]?.rows ?? [];
        return {
          mode: entry.mode,
          label: entry.label,
          model,
          rows: rows.length,
          // 画布手绘没有 DOM 可断言：给 E2E 一个「图里真的带了海报」的锚点（同 `RedBlackShareDialog`）
          posters: rows.filter((row) => row.poster).length,
          fileName: `BIFF2026-红黑榜-${entry.label}.png`,
        };
      }).filter((shot) => shot.model.boards.length > 0),
    [films, crowd, board, skins, syncedFaces, site, mine, priorRate, today],
  );

  /** 点了第几次「生成图片」——出图由它触发（见文件头：确认之前不画）。 */
  const [genNonce, setGenNonce] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  /** 每榜画好的那一张 —— 两张**各自**独立：各自的「下载 / 复制」只作用于自己那张。 */
  const [images, setImages] = useState<Partial<Record<SortMode, RankShotImage>>>({});
  /** 画布节点（**常驻**挂载，见下面 JSX 的说明）—— 出图时要往它上面画，所以按榜存一份引用。 */
  const canvasRefs = useRef<Partial<Record<SortMode, HTMLCanvasElement | null>>>({});

  const ready = shots.length > 0 && shots.every((shot) => images[shot.mode]);

  // 出图那一刻读的是**最新**那份模型：用 ref 跟上，而不是把它塞进生成 effect 的依赖 ——
  // 依赖里带上它的话，出图途中票数一刷新就会跑 cleanup 把这次出图中断（画到一半的那张作废，
  // 而按钮又不会自动重画，用户只会看到「点了没反应」）。
  const shotsRef = useRef(shots);
  useEffect(() => {
    shotsRef.current = shots;
  }, [shots]);

  useEffect(() => {
    if (!genNonce) return;
    const current = shotsRef.current;
    if (!current.length) return;
    let canceled = false;
    setPending(true);
    // 重画前先清掉上一次的失败提示：再点一次生成之后它还挂着，会与这张**正在画**的图同时显示
    setError("");
    void (async () => {
      try {
        // 两张图的海报**一次**加载完（`loadPosterImages` 自己会去重）：分开加载会让第二张
        // 等第一张的那一批 URL 再走一遍网络。
        const images_ = await loadPosterImages(
          current.flatMap((shot) =>
            shot.model.boards.flatMap((section) =>
              section.rows.flatMap((row) => (row.poster ? [row.poster] : [])),
            ),
          ),
        );
        if (canceled) return;
        const drawn: Partial<Record<SortMode, RankShotImage>> = {};
        for (const shot of current) {
          const canvas = canvasRefs.current[shot.mode];
          // 画布没挂上（理论上不会：它常驻）→ 跳过这一张，而不是让整次出图失败
          if (!canvas) continue;
          drawRbPoster(canvas, shot.model, images_);
          const blob = await posterBlob(canvas);
          if (!blob) throw new Error("empty canvas");
          const px = posterPixels(POSTER_W, rbPosterHeight(shot.model));
          drawn[shot.mode] = { blob, width: px.width, height: px.height };
        }
        if (canceled) return;
        setImages(drawn);
      } catch {
        if (!canceled) setError("图片生成失败，请重新生成。");
      } finally {
        if (!canceled) setPending(false);
      }
    })();
    return () => {
      canceled = true;
      // ⚠ 卸载 / 又点了一次时复位：那个 finally 因为 canceled 被跳过，不复位按钮会永远停在
      //   「正在生成…」（与两个分享图弹层同一条）。
      setPending(false);
    };
  }, [genNonce]);

  return (
    <DialogContainer onDismiss={onDismiss}>
      <Dialog size="L">
        <Heading slot="title">红黑榜排行</Heading>
        <Content>
          {/* 这一块 = 「把分享图那一屏搬进来」：深底、海报色、分节头是一根红竖条。
              色值全部来自 `POSTER_SKIN`（见文件头），本组件不写死任何一个色值。 */}
          <div className="rbr-sheet" style={POSTER_SKIN}>
            <p className="rbr-lede">
              红榜 / 黑榜各取前 {RANK_LIMIT} 名 · 按该榜自己的贴纸数排（同数量比评分）。
            </p>
            {boards.length === 0 ? (
              /* 空榜只说一句「怎么开始」—— 两列都空时**不**渲染两个空标题 */
              <p className="rbr-empty" role="status">
                榜上还没有贴纸 —— 点「快速投票」投一枚，这里就有排名了。
              </p>
            ) : (
              <div className="rbr-cols" data-rbr-boards={boards.length}>
                {boards.map((board) => (
                  <section className="rbr-col" data-rbr-board={board.mode} key={board.mode}>
                    {/* 分节头 = 红色竖条 + 标题 + 行数（形态照分享图的 `drawSection`）。
                        行数带上是因为：红榜第 37 名之后就没了，读者得知道「这是全部」 */}
                    <h3 className="rbr-col-title">
                      <span className="rbr-bar" aria-hidden="true" />
                      <span className="rbr-col-label">{board.label}</span>
                      <span className="rbr-col-count">{board.rows.length}</span>
                    </h3>
                    <ol className="rbr-list">
                      {board.rows.map((row, index) => {
                        const rank = index + 1;
                        return (
                          <li
                            className="rbr-row"
                            key={row.key}
                            data-rbr-key={row.key}
                            data-rbr-rank={rank}
                          >
                            <span className="rbr-rank">{String(rank).padStart(2, "0")}</span>
                            {row.poster ? (
                              /* `decoding="async"` 与卡片同一处置：一屏最多 100 张海报，
                                 同步解码会在主线程上抢滚动（它只影响解码时机，不改变布局与优先级） */
                              <img
                                className="rbr-poster"
                                src={row.poster}
                                loading="lazy"
                                decoding="async"
                                alt=""
                              />
                            ) : (
                              /* 缺图是常态 —— 走统一的占位块（印片名首字），**不编一个路径** */
                              <span className="rbr-poster rbr-poster--none" aria-hidden="true">
                                {row.title.trim().charAt(0)}
                              </span>
                            )}
                            <span className="rbr-body">
                              <span className="rbr-title">{row.title}</span>
                              {row.en && <span className="rbr-en">{row.en}</span>}
                              {/* 分段上色（分享图 `drawCounts`）：标签与分隔符走次级色，
                                  只有两个数字上色。⚠ 深底上用的是**海报那一对**
                                  （`COLORS.red2` / `COLORS.ink2`），不是浅底的 `.rb-tally__*` */}
                              <span className="rbr-counts">
                                <span className="rbr-red">红 {row.red}</span>
                                <span>{" · "}</span>
                                <span className="rbr-black">黑 {row.black}</span>
                              </span>
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                ))}
              </div>
            )}
          </div>

          {/* 出图（2026-10-16，见文件头）：每榜一张。
              ⚠ 画布**常驻挂载**（用 `hidden` 收起，而不是「出了图才渲染」）—— 出图那一刻要往它上面
                画，渲染条件一收就没有可供绘制的节点了。这也是 `.rbr-shot-preview[hidden]` 那条
                守卫存在的原因：本仓库没引 Tailwind preflight，光靠 `hidden` 属性压不住 `display: block`。 */}
          {shots.length > 0 && (
            <>
              <p className="rbr-shots-lede" role="status">
                {pending
                  ? "正在生成图片…"
                  : ready
                    ? "两张图都好了 —— 每张都能单独复制或下载。"
                    : "点下面的「生成图片」，红榜 / 黑榜各出一张（每张都能单独复制）。"}
              </p>
              {error && (
                <p role="alert" className="error-text">
                  {error}
                </p>
              )}
              <div className="rbr-shots" data-rbr-shots={shots.length}>
                {shots.map((shot) => {
                  const image = images[shot.mode];
                  return (
                    <section className="rbr-shot" data-rbr-shot={shot.mode} key={shot.mode}>
                      <h3 className="rbr-shot-head">
                        <span className="rbr-shot-label">{`${shot.label}图`}</span>
                        <span className="rbr-shot-size" role="status">
                          {image
                            ? `${image.width} × ${image.height} px · PNG 约 ${(image.blob.size / 1048576).toFixed(1)} MB`
                            : `还没出图 · 前 ${shot.rows} 名`}
                        </span>
                      </h3>
                      <div className="rbr-shot-view">
                        <canvas
                          ref={(node) => {
                            canvasRefs.current[shot.mode] = node;
                          }}
                          className="rbr-shot-preview"
                          hidden={!image}
                          aria-label={`${shot.label}图预览`}
                          data-poster-count={shot.posters}
                        />
                      </div>
                      {image && (
                        <div className="rbr-shot-actions">
                          <Button onPress={() => download(image.blob, shot.fileName)}>
                            下载 PNG 图片
                          </Button>
                          <ActionButton
                            onPress={() => void copyImageOrDownload(image.blob, shot.fileName)}
                          >
                            复制图片
                          </ActionButton>
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </>
          )}
        </Content>
        <ButtonGroup>
          {/* 往外发的入口 —— 用户原话：「没有分享按钮吧无法分享结果」/「排行榜自己出图 + 复制图片」。
              ⚠ 这是一枚**出图**按钮（点了才画，见文件头），不是「打开另一个弹层」：它不再交接给
                分享图弹层（那条路由 2026-10-16 起作废）。出好之后每张图各自带「下载 / 复制」，
                而这枚仍然留着 —— 它是「重来一次」的入口（票数变了想重出一份就点它）。
              ⚠ **常驻 + 出图中也不 `isDisabled`**（唯一的禁用条件是空榜）：卸载或禁用都会让焦点
                掉出弹层，而 Esc 是弹层容器的 keydown ⇒「Esc 关不掉」（与两个分享图弹层同一条）。
              ⚠ 空榜时禁用：一票都没有就没有排行可出图，点开只会得到两张空图。
              ⚠ 它是这一层的主操作，所以是实底 `Button`（「关闭」退成 secondary）。 */}
          <Button
            isDisabled={boards.length === 0}
            onPress={() => setGenNonce((count) => count + 1)}
          >
            {pending ? "正在生成…" : genNonce > 0 ? "重新生成图片" : "生成图片"}
          </Button>
          <Button variant="secondary" onPress={onDismiss}>
            关闭
          </Button>
        </ButtonGroup>
      </Dialog>
    </DialogContainer>
  );
}
