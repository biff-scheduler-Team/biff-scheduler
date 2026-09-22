import { download } from "../app/download";
export { download } from "../app/download";
import { PosterPreview } from "./PosterPreview";
import { buildPosterModel, type PosterModel } from "../poster";
import { dateInfo } from "../util";
import type { Catalog } from "../types";
import type { SavedPlan } from "../state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  Heading,
  Picker,
  PickerItem,
  TextArea,
  ToastQueue,
} from "./spectrum";
import { useCatalog } from "../app/store";
import { topPlanCodes } from "../app/agenda-model";
import { buildIcs, type PickRow } from "../ics";
import { buildShareText } from "../share";
import { parseBackupText, parseIcsCodes, restore, snapshot } from "../backup";
import {
  mergeScreenings,
  replaceScreenings,
  savedPlans,
  slotOf,
  store,
} from "../state";
import { talkOnOf } from "../gv";
import { todayIsoLocal } from "../util";
import { copyText } from "../clipboard";

/** 「导出范围」里的**伪方案 id** —— 选中它 = 按**当前行程**导出(取行程「每组第一顺位 + 共同场次」)。 */
export const SCOPE_CURRENT = "current";

/** 场次集合概要:`29 场，OCT 7–OCT 10`(排期里查不到的 code 记「N 场已不在排期」)。
 *  ⚠ 已保存方案与「当前行程」两个范围**共用本函数** —— 各算一份必然让同一份数据印出两个场数。 */
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

/** 已保存方案的概要(薄封装,见 `codesOutline`)。 */
export function planOutline(cat: Catalog, plan: SavedPlan): string {
  return codesOutline(cat, plan.codes);
}

function ImportData() {
  const { cat, keyOf } = useCatalog();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const ics = /BEGIN:VCALENDAR/i.test(text);
  const parsed = ics ? parseIcsCodes(text) : parseBackupText(text);
  const validCodes =
    parsed.ok && "codes" in parsed
      ? parsed.codes.filter((c) => cat.byCode.has(c))
      : [];
  const unknownCodes =
    parsed.ok && "codes" in parsed
      ? parsed.codes.length - validCodes.length
      : 0;
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
  return (
    <section className="import-data">
      <h2>导入备份或日历</h2>
      <label className="file-label">
        选择 JSON 或 ICS 文件
        <input
          aria-label="选择备份或日历文件"
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
      <TextArea label="或粘贴备份内容" value={text} onChange={importText} />
      {text && !parsed.ok && (
        <p role="alert" className="error-text">
          {parsed.error.replaceAll(" —— ", "，")}
        </p>
      )}
      {parsed.ok && (
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
                  <p>当前选片、备注、设置和方案将被这份备份替换。</p>
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
  // 导出范围:默认「当前行程」,已保存方案仍可显式选。
  const [scope, setScope] = useState<string>(SCOPE_CURRENT);
  const [preview, setPreview] = useState(false);
  const generation = useRef(0);
  const [image, setImage] = useState<{
    id: number;
    planId: string;
    model: PosterModel;
    loading: boolean;
  } | null>(null);
  const currentCodes = useMemo(() => topPlanCodes(plans), [plans]);
  // 选了已保存方案 → 按方案快照;方案被别的标签页删掉(没有 Picker 事件) → 回落最后一个方案;都没有 → 当前行程。
  const plan =
    scope === SCOPE_CURRENT
      ? undefined
      : savedPlans.find((p) => p.id === scope) ?? savedPlans.at(-1);
  const scopeCodes = plan?.codes ?? currentCodes;
  const scopeId = plan?.id ?? SCOPE_CURRENT;
  const activeImage = image?.planId === scopeId ? image : null;
  useEffect(() => {
    // Storage sync may remove the selected plan without a Picker change event.
    setImage((current) => current?.planId === scopeId ? current : null);
  }, [scopeId]);
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
      planId: scopeId,
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
              {rows.length || savedPlans.length ? (
                <section className="form-stack">
                  <Picker
                    label="导出范围"
                    value={scopeId}
                    onChange={(id) => {
                      setScope(String(id));
                      setImage(null);
                    }}
                  >
                    <PickerItem id={SCOPE_CURRENT}>
                      当前行程（{codesOutline(cat, currentCodes)}）
                    </PickerItem>
                    {savedPlans.map((p) => (
                      <PickerItem key={p.id} id={p.id}>
                        {p.name}（{planOutline(cat, p)}）
                      </PickerItem>
                    ))}
                  </Picker>
                  <p className="muted">
                    「当前行程」取行程里的全部场次（每组第一顺位 + 共同场次），改完行程直接导出即可；
                    已保存方案是快照，之后改行程不会跟着变。
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
                  备份包括选片、备注、顺位、已保存方案和设置。换设备或域名时可以导入恢复。
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
