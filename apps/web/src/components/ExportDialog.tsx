import { download } from "../app/download";
export { download } from "../app/download";
import { PosterPreview } from "./PosterPreview";
import { buildPosterModel, type PosterModel } from "../poster";
import { dateInfo } from "../util";
import type { Catalog } from "../types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  Heading,
  TextArea,
  ToastQueue,
} from "./spectrum";
import { useCatalog } from "../app/store";
import { topPlanCodes } from "../app/agenda-model";
import { buildIcs, type PickRow } from "../ics";
import { buildShareText } from "../share";
import { parseBackupText, parseIcsCodes, restore, snapshot } from "../backup";
import { looksLikeTicketImport, parseTicketImport } from "../ticket-import";
import { applyTicketImport, mergeScreenings, replaceScreenings, slotOf, store } from "../state";
import { talkOnOf } from "../gv";
import { todayIsoLocal } from "../util";
import { copyText } from "../clipboard";

/** 场次集合概要:`29 场，OCT 7–OCT 10`(排期里查不到的 code 记「N 场已不在排期」)。
 *  ⚠ 2026-09-22 起它只服务**一个**范围(当前行程,`PLAN-20260922105228`)——
 *  「已保存方案」那第二个范围已整体下线,原先「两个范围各算一份会让同一份数据印出两个场数」的坑随之消失。 */
export function codesOutline(cat: Catalog, codes: string[]): string {
  const shows = codes
    .flatMap((code) => {
      const s = cat.byCode.get(code);
      return s ? [s] : [];
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.start_time.localeCompare(b.start_time),
    );
  const parts = [`${shows.length} 场`];
  if (shows.length) {
    const first = dateInfo(shows[0].date).label;
    const last = dateInfo(shows.at(-1)!.date).label;
    parts.push(first === last ? first : `${first}–${last}`);
  }
  const missing = codes.length - shows.length;
  if (missing) parts.push(`${missing} 场已不在排期`);
  return parts.join("，");
}

/* `planOutline()` 随「已保存方案」一起删除(2026-09-22,`PLAN-20260922105228`)。
 * 它只是 `codesOutline(cat, plan.codes)` 的薄封装,方案的 codes 没了,它也就没有输入了。 */

function ImportData() {
  const { cat, keyOf } = useCatalog();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const ics = /BEGIN:VCALENDAR/i.test(text);
  // 三种内容共用一个框(备份 / .ics / 票务),**先按顶层形状分流再各报各的错** ——
  // 把一份票务 JSON 当备份解析,报出来的会是「没找到任何 biff.* 数据」,用户看不懂
  // (判据与理由见 `ticket-import.ts::looksLikeTicketImport`)。
  const ticketParsed = !ics && looksLikeTicketImport(text) ? parseTicketImport(text) : null;
  const parsed = ics ? parseIcsCodes(text) : parseBackupText(text);
  const validCodes =
    parsed.ok && "codes" in parsed
      ? parsed.codes.filter((c) => cat.byCode.has(c))
      : [];
  const unknownCodes =
    parsed.ok && "codes" in parsed
      ? parsed.codes.length - validCodes.length
      : 0;
  // 票务导入:只留片单里有的场次(不在当前届排期里的 code 没有场次可挂,与 .ics 同一分工)。
  const ticketRows = ticketParsed?.ok ? ticketParsed.rows.filter((r) => cat.byCode.has(r.code)) : [];
  const unknownTickets = ticketParsed?.ok ? ticketParsed.rows.length - ticketRows.length : 0;
  const ticketSeats = ticketRows.reduce((n, r) => n + (r.seats?.length ?? 0), 0);
  const importText = (value: string) => {
    if (value === text) return;
    setText(value);
    setError("");
    setConfirmed(false);
  };
  const apply = (mode: "merge" | "replace") => {
    if (!parsed.ok) return;
    try {
      if ("data" in parsed) {
        restore(localStorage, parsed.data);
        window.dispatchEvent(new Event("iffday:workspace-change"));
        location.reload();
      } else {
        if (mode === "merge") mergeScreenings(validCodes, keyOf);
        else replaceScreenings(validCodes, keyOf);
        ToastQueue.positive(`已导入 ${validCodes.length} 场`, {
          timeout: 5000,
        });
        importText("");
      }
    } catch {
      setError(
        "写入失败，浏览器存储可能已满。请保留备份文件，释放空间后重试。",
      );
    }
  };
  /** 导入票务:并行程 → 写明细 → 标「已抢到」。
   *  ⚠ **顺序不能反**:`rebuildIndex()` 会把不在行程里的票务明细当脏数据 prune 掉
   *    (`state.ts::staleTicketCodes`)—— 先写明细再并行程,刚导进去的票会在下一次 rebuild 时凭空消失。
   *  ⚠ 这里不做 try/catch 的存储写入分支:明细/三态各自内部已吞掉配额异常
   *    (`saveTicketInfo` / `saveTickets`),不会像 `restore` 那样抛出去。 */
  const applyTickets = () => {
    if (!ticketParsed?.ok) return;
    mergeScreenings(ticketRows.map((r) => r.code), keyOf);
    applyTicketImport(ticketRows, true);
    ToastQueue.positive(`已导入 ${ticketRows.length} 笔票务（${ticketSeats} 张）`, {
      timeout: 5000,
    });
    importText("");
  };
  return (
    <section className="import-data">
      <h2>导入备份 / 日历 / 票务</h2>
      <label className="file-label">
        选择 JSON 或 ICS 文件
        <input
          aria-label="选择备份、日历或票务文件"
          type="file"
          accept=".json,.ics,application/json,text/calendar"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              void file
                .text()
                .then(importText)
                .catch(() => setError("文件读取失败，请重新选择。"));
            e.target.value = "";
          }}
        />
      </label>
      <TextArea label="或粘贴备份 / 日历 / 票务内容" value={text} onChange={importText} />
      {/* ⚠ 票务分支存在时**不再报**备份通道的错:同一段文本被两条通道各判一次,
          备份那条必然失败(没有 biff.* 键),报出来只会盖掉真正对症的提示。 */}
      {text && !ticketParsed && !parsed.ok && (
        <p role="alert" className="error-text">
          {parsed.error.replaceAll(" —— ", "，")}
        </p>
      )}
      {ticketParsed && (
        <div className="import-preview">
          {ticketParsed.ok ? (
            <>
              <p>
                识别到 {ticketRows.length} 笔票务、{ticketSeats} 张票
                {unknownTickets ? `；另有 ${unknownTickets} 笔的场次不在当前排期，会跳过` : ""}。
              </p>
              <p className="muted">
                这些场次会一并加进行程，并标为「已抢到」；同一场已有的票务信息会被这份文件覆盖。
              </p>
              <div className="inline-actions">
                <Button isDisabled={!ticketRows.length} onPress={applyTickets}>
                  导入票务
                </Button>
              </div>
            </>
          ) : (
            <p role="alert" className="error-text">
              {ticketParsed.error.replaceAll(" —— ", "，")}
            </p>
          )}
        </div>
      )}
      {!ticketParsed && parsed.ok && (
        <div className="import-preview">
          <p>
            {"data" in parsed
              ? `找到 ${Object.keys(parsed.data).length} 项本机数据。恢复将整体替换当前数据。`
              : `识别到 ${validCodes.length} 场${unknownCodes ? `，${unknownCodes} 场已不在当前排期，会跳过` : ""}。`}
          </p>
          {"data" in parsed ? (
            <>
              {!confirmed ? (
                <ActionButton onPress={() => setConfirmed(true)}>
                  准备恢复备份
                </ActionButton>
              ) : (
                <div className="notice">
                  <p>当前选片、备注、顺位和设置将被这份备份替换。</p>
                  <Button variant="negative" onPress={() => apply("replace")}>
                    确认恢复并刷新
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="inline-actions">
              <Button
                isDisabled={!validCodes.length}
                onPress={() => apply("merge")}
              >
                合并到当前行程
              </Button>
              {confirmed ? (
                <Button
                  variant="negative"
                  isDisabled={!validCodes.length}
                  onPress={() => apply("replace")}
                >
                  确认替换行程
                </Button>
              ) : (
                <ActionButton
                  isDisabled={!validCodes.length}
                  onPress={() => setConfirmed(true)}
                >
                  替换已排场次
                </ActionButton>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
export function ExportDialog() {
  const { cat, plans } = useCatalog();
  const [preview, setPreview] = useState(false);
  const generation = useRef(0);
  const [image, setImage] = useState<{
    id: number;
    signature: string;
    model: PosterModel;
    loading: boolean;
  } | null>(null);
  // 「导出范围」只剩**当前行程**一个(2026-09-22,`PLAN-20260922105228`):
  // 每组第一顺位 + 共同场次,口径在 `agenda-model.ts::topPlanCodes`。
  const scopeCodes = useMemo(() => topPlanCodes(plans), [plans]);
  // ⚠ 出图是异步的,期间行程可能被改(本标签页切场次 / 另一标签页改完 picks 后 storage 同步过来)。
  //   所以每张图都记着**生成时那份场次集合**,集合一变就作废 —— 否则用户会拿到一张
  //   「导出内容与当前行程对不上」的图。这是旧「所选方案被别的标签页删掉 → 作废」判据退役后的等价物
  //   (旧判据的前提是「范围可被外部删除」,而当前行程不依赖任何可被外部删除的对象)。
  const scopeSignature = scopeCodes.join("|");
  const activeImage = image?.signature === scopeSignature ? image : null;
  useEffect(() => {
    setImage((current) => current?.signature === scopeSignature ? current : null);
  }, [scopeSignature]);
  const onImageLoadingChange = useCallback((id: number, loading: boolean) => {
    setImage((current) => current?.id === id ? { ...current, loading } : current);
  }, []);
  const rows: PickRow[] = scopeCodes
    .filter((c) => cat.byCode.has(c))
    .map((code) => ({
      code,
      note: store.picks.get(slotOf(code)?.key ?? "")?.note ?? "",
    }));
  const share = buildShareText(cat, rows, store.mappings, talkOnOf);
  const buildImage = () => {
    const model = buildPosterModel(cat, rows, store.mappings, talkOnOf);
    if (!model) return;
    setImage({
      id: ++generation.current,
      signature: scopeSignature,
      model,
      loading: true,
    });
  };
  return (
    <Dialog size="L">
      {({ close }) => (
        <>
          <Heading slot="title">导出与分享</Heading>
          <Content>
            <div className="export-content">
              {rows.length ? (
                <section className="form-stack">
                  {/* 导出范围只剩一个,故不再用下拉(单选项下拉是个点了没变化的死控件),
                      改成一行静态说明:口径与场数仍是同一份 `codesOutline`。 */}
                  <p className="export-scope">
                    导出范围：当前行程（{codesOutline(cat, scopeCodes)}）
                  </p>
                  <p className="muted">
                    取行程里的全部场次（每组第一顺位 + 共同场次），改完行程直接导出即可。
                  </p>
                  <p className="muted">
                    {rows.length} 场有效排期。日历时间会自动转换到手机所在时区。
                  </p>
                  <div className="inline-actions">
                    <Button
                      isDisabled={!rows.length}
                      onPress={() =>
                        download(
                          buildIcs(
                            cat,
                            rows,
                            store.mappings,
                            store.settings.alarmMin,
                            talkOnOf,
                          ),
                          "biff2026.ics",
                          "text/calendar;charset=utf-8",
                        )
                      }
                    >
                      导出 ICS 日历
                    </Button>
                    <ActionButton
                      isDisabled={!rows.length}
                      onPress={() => {
                        setPreview(true);
                        void copyText(share).then((ok) =>
                          ok
                            ? ToastQueue.positive("文案已复制", {
                                timeout: 5000,
                              })
                            : ToastQueue.negative(
                                "复制失败，可以在预览中手动复制。",
                              ),
                        );
                      }}
                    >
                      分享文案
                    </ActionButton>
                    <ActionButton
                      isDisabled={!rows.length}
                      isPending={activeImage?.loading ?? false}
                      onPress={() => {
                        void buildImage();
                      }}
                    >
                      生成分享图片
                    </ActionButton>
                  </div>
                  {preview && (
                    <div className="form-stack">
                      <TextArea label="行程分享文案" value={share} isReadOnly />
                      <ActionButton
                        onPress={() => {
                          void copyText(share).then((ok) =>
                            ok
                              ? ToastQueue.positive("文案已复制", {
                                  timeout: 5000,
                                })
                              : ToastQueue.negative(
                                  "复制失败，可以选择上方文案手动复制。",
                                ),
                          );
                        }}
                      >
                        复制文案
                      </ActionButton>
                    </div>
                  )}
                  {activeImage && (
                    <PosterPreview
                      key={activeImage.id}
                      generationId={activeImage.id}
                      model={activeImage.model}
                      onLoadingChange={onImageLoadingChange}
                    />
                  )}
                </section>
              ) : (
                <div className="notice">
                  <h2>还没有安排场次</h2>
                  <p>
                    在排片表里把要看 / 要抢的场次加进行程，再回这里导出日历、分享文案或分享图片。
                  </p>
                </div>
              )}
              <section className="backup-section">
                <h2>数据备份</h2>
                <p className="muted">
                  备份包括选片、备注、顺位和设置。换设备或域名时可以导入恢复。
                </p>
                <ActionButton
                  onPress={() => {
                    try {
                      download(
                        JSON.stringify(
                          snapshot(localStorage, new Date(), location.origin),
                          null,
                          2,
                        ),
                        `biff-backup-${todayIsoLocal()}.json`,
                        "application/json",
                      );
                    } catch {
                      ToastQueue.negative(
                        "无法读取本机数据，请检查浏览器存储权限。",
                      );
                    }
                  }}
                >
                  导出数据备份
                </ActionButton>
              </section>
              <ImportData />
            </div>
          </Content>
          <ButtonGroup>
            <Button variant="secondary" onPress={close}>
              关闭
            </Button>
          </ButtonGroup>
        </>
      )}
    </Dialog>
  );
}
