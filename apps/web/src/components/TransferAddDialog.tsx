import { useState } from "react";
import { matchScreenings } from "../app/schedule-search";
import { useCatalog } from "../app/store";
import { venueShort } from "../legend";
import { setTicket, slotOf, store, toggleScreening } from "../state";
import { dateInfo, displayTitle, filmNodeKey } from "../util";
import type { Screening } from "../types";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  DialogTrigger,
  Heading,
  SearchField,
  ToastQueue,
} from "./spectrum";
import "./screening-social.css";

/** 「我的行程」顶部的「添加转票场次」入口。 */
export function TransferAddEntry() {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(next) => {
        // 每次打开都重挂载:清空关键词(与 GvDurationButton 同一手法)
        if (next) setSession((n) => n + 1);
        setOpen(next);
      }}
    >
      <ActionButton>添加转票场次</ActionButton>
      {/* DialogTrigger 无条件渲染 children,故只在打开时挂载(与 GvDurationButton 同一手法) */}
      {open && <TransferAddDialog key={session} />}
    </DialogTrigger>
  );
}

function TransferAddDialog() {
  const { cat } = useCatalog();
  const [query, setQuery] = useState("");
  const results = matchScreenings(cat.schedule.screenings, query);

  const mark = (s: Screening) => {
    const inPlan = Boolean(slotOf(s.code));
    // ⚠ 顺序要紧:先「加入行程」(会 rebuildIndex → prune 掉不在行程里的票务状态),
    //   再写票务状态。反过来的话状态会被 prune 当场清掉。
    if (!inPlan) toggleScreening(filmNodeKey(cat, s), s.code);
    setTicket(s.code, "got", "transfer");
    ToastQueue.positive(`${s.code} 已记入实际行程（转票）`);
  };

  return (
    <Dialog size="M">
      {({ close }) => (
        <>
          <Heading slot="title">添加转票场次</Heading>
          <Content>
            <div className="transfer-dialog">
              <p className="transfer-hint">
                收到别人转的票？按场次编号或片名找到那一场，一步记入「实际行程」并标为转票。
              </p>
              <SearchField
                label="场次编号或片名"
                placeholder="如 419 / 峡湾 / Fjord"
                value={query}
                onChange={setQuery}
              />
              {query.trim() !== "" && results.length === 0 && (
                <p className="transfer-hint">
                  没找到这一场。编号要写官方 3 位（如 001），片名中英文都可以。
                </p>
              )}
              <ul className="transfer-list">
                {results.map((s) => {
                  const venue = cat.venueById.get(s.venue_id);
                  const inPlan = Boolean(slotOf(s.code));
                  return (
                    <li className="transfer-row" key={s.code} data-transfer-code={s.code}>
                      <div className="transfer-row-main">
                        <strong>{displayTitle(s, store.mappings.get(s.code)?.title_cn)}</strong>
                        <span>
                          {s.code} · {dateInfo(s.date).label} {s.start_time.slice(0, 5)} ·{" "}
                          {venue ? venueShort(venue) : s.venue_display}
                          {inPlan ? " · 已在行程" : ""}
                        </span>
                      </div>
                      {/* aria-label 必须**含可见文案**(无障碍的 label-in-name):
                          只写「把场次 004 记为转票」会让按可见文字操作的语音用户点不到它。 */}
                      <ActionButton
                        aria-label={`${inPlan ? "标记为转票" : "加入并标记转票"}（场次 ${s.code}）`}
                        onPress={() => mark(s)}
                      >
                        {inPlan ? "标记为转票" : "加入并标记转票"}
                      </ActionButton>
                    </li>
                  );
                })}
              </ul>
            </div>
          </Content>
          <ButtonGroup>
            <Button variant="secondary" onPress={close}>
              完成
            </Button>
          </ButtonGroup>
        </>
      )}
    </Dialog>
  );
}
