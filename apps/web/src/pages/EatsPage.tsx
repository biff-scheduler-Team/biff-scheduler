// 「吃喝」页(2026-09-16,`PLAN-20260916232230`)—— 把《BIFF吃喝》那张釜山餐厅表搬进站内。
//
// ★ 为什么单开一页:电影节期间「哪家馆子开着、在哪」是行程之外的第二份刚需,
//   和排片/选片/票务都不共享数据,塞进任何既有页面都是噪声。
//
// ★ 为什么每张卡挂三个地图链接:「韩国店在 Naver 的收录率高于 Google」是选片现场的共识。
//   表里有韩文名,正好拿来做检索串。三条都是普通 URL,**不需要 API Key、不消耗配额** ——
//   这也是本轮刻意不接 Places API 的原因(Enterprise SKU 每月只有 1,000 次免费)。
//   链接模板一律来自 `legend.ts`,本页不自己拼 URL。
//
// ★ 数据来自 `public/eats.json`(离线管线 `tools/build_eats.py` 的产物,检入仓库)。
//   用户自己加的店走 `biff.eats.v1`,默认只存本地;登录 IFFDAY 后随既有链路同步到自己那份。
//
// ★ 刻意**不自己算「现在是否营业」**:营业时间那列是原表的自由文本(含「15:00-17:00 休息」
//   这类中文夹杂),本地解析必然错。宁可不显示,也不显示一个自己编的结论。

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  ActionButton,
  Button,
  ButtonGroup,
  Content,
  Dialog,
  DialogTrigger,
  Heading,
  Picker,
  PickerItem,
  TextArea,
  TextField,
  ToastQueue,
} from "../components/spectrum";
import { QuerySearchField } from "../components/QuerySearchField";
import { useQuery } from "../app/hooks";
import {
  addSubmission,
  DISTRICT_LABEL,
  districtLabel,
  eatLinkLabel,
  eatLinks,
  EATS_KEY,
  eatName,
  eatQuery,
  eatSubName,
  loadEatsFile,
  lookupDisabled,
  lookupPlace,
  readSubmissions,
  removeSubmission,
  type EatsFile,
  type EatShop,
  type EatSubmission,
  type PlaceHit,
} from "../eats";
import "./eats.css";

/** 一行 = 一张店卡。把「表里的店」与「用户自己加的店」归一成同一个形状,列表只认这一种。 */
interface Row {
  id: string;
  mine: boolean;
  name: string;
  sub: string;
  district: string;
  menu: string;
  hours: string;
  price: string;
  address: string;
  addressAlt: string;
  note: string;
  query: string;
  /** 表里「链接」列人工整理的那条(小红书 / naver.me / instagram),没有就是空串。 */
  link: string;
  /** 送去做数据源查询的两个字段:**店名**与**韩文地址**分开传 —— 上游要用地址里的区名收窄范围,
   *  而名称闸门只能拿店名比。拼成一个长串会两头都做不好(见 `place-lookup.ts::districtTokenOf`)。 */
  lookupName: string;
  lookupAddress: string;
}

function rowOfShop(shop: EatShop): Row {
  return {
    id: shop.id,
    mine: false,
    name: eatName(shop),
    sub: eatSubName(shop),
    district: shop.district,
    menu: shop.menu,
    hours: shop.hours,
    price: shop.price,
    address: shop.address_kr,
    addressAlt: shop.address_en,
    note: shop.note,
    query: eatQuery(shop),
    link: shop.link,
    lookupName: shop.name_kr || shop.name_zh || shop.name_en,
    lookupAddress: shop.address_kr,
  };
}

function rowOfSubmission(entry: EatSubmission): Row {
  return {
    id: entry.id,
    mine: true,
    name: entry.name,
    sub: "",
    district: entry.district,
    menu: "",
    hours: "",
    price: "",
    address: entry.address,
    addressAlt: "",
    note: entry.note,
    query: entry.address ? `${entry.name} ${entry.address}` : entry.name,
    link: "",
    lookupName: entry.name,
    lookupAddress: entry.address,
  };
}

function hit(row: Row, needle: string): boolean {
  if (!needle) return true;
  return [row.name, row.sub, row.address, row.addressAlt, row.menu, row.note, row.hours]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/** 卡片上的三条地图链接。`rel`/`target` 与全站外链一致(LibraryPage 的豆瓣跳转同款)。
 *  Naver 那条在查到精确店铺页时换成精确链接 —— 用户少点一次搜索结果。 */
function EatLinks({ query, hit, curated }: { query: string; hit?: PlaceHit | null; curated: string }) {
  const links = eatLinks(query);
  const naver = hit?.provider === "naver" && hit.url ? hit.url : links.naver;
  return (
    <p className="eat-links">
      <a href={links.google} target="_blank" rel="noopener noreferrer" title="在 Google 地图打开">
        Google 地图 ↗
      </a>
      <a
        href={naver}
        target="_blank"
        rel="noopener noreferrer"
        title={hit ? `Naver 店铺页：${hit.name}` : "在 Naver 地图搜索"}
      >
        Naver 地图{hit ? "（精确）" : ""} ↗
      </a>
      <a href={links.kakao} target="_blank" rel="noopener noreferrer" title="在 Kakao 地图打开">
        Kakao 地图 ↗
      </a>
      {/* 表里人工整理的那条排最后:它是「别人写的食记 / 精确短链」,不是地图入口 */}
      {curated && (
        <a
          className="eat-curated"
          href={curated}
          target="_blank"
          rel="noopener noreferrer"
          title={curated}
        >
          {eatLinkLabel(curated)} ↗
        </a>
      )}
    </p>
  );
}

function EatCard({
  row,
  hit,
  onRemove,
}: {
  row: Row;
  hit?: PlaceHit | null;
  onRemove?: (id: string) => void;
}) {
  // 表里的地址常写成韩文 + 英文两行,查到的道路名地址若与之不同,补一行更可靠的
  const extraAddress = hit?.roadAddress && hit.roadAddress !== row.address ? hit.roadAddress : "";
  return (
    <li className={`eat-card${row.mine ? " eat-mine" : ""}`} data-eat-id={row.id}>
      <div className="eat-head">
        <div>
          <h3 className="eat-name">{row.name}</h3>
          {row.sub && <p className="eat-sub">{row.sub}</p>}
        </div>
        <div className="eat-chips">
          <span className="eat-chip" data-district={row.district}>
            {districtLabel(row.district)}
          </span>
          {row.menu && <span className="eat-chip">{row.menu}</span>}
          {row.mine && <span className="eat-chip eat-chip-mine">我添加的</span>}
        </div>
      </div>
      {(row.hours || row.price) && (
        <p className="eat-meta">
          {row.hours && <span>{row.hours}</span>}
          {row.price && <span>人均 ¥{row.price}</span>}
        </p>
      )}
      {row.address && <p className="eat-addr">{row.address}</p>}
      {extraAddress && <p className="eat-addr">{extraAddress}</p>}
      {!row.address && row.addressAlt && <p className="eat-addr">{row.addressAlt}</p>}
      {row.note && <p className="eat-note">{row.note}</p>}
      {/* 电话只在查到时才出现 —— 表里没有这一列,是自己补上的 */}
      {hit?.phone && <p className="eat-meta eat-phone">电话 {hit.phone}</p>}
      <EatLinks query={row.query} hit={hit} curated={row.link} />
      {row.mine && onRemove && (
        <Button variant="secondary" onPress={() => onRemove(row.id)}>
          删除这家
        </Button>
      )}
    </li>
  );
}

/** 「添加店铺」入口:每次打开重挂载,清掉上一次填的内容(与 TransferAddDialog 同一手法)。 */
function EatAddEntry({ onAdded }: { onAdded: (list: EatSubmission[]) => void }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(next) => {
        if (next) setSession((n) => n + 1);
        setOpen(next);
      }}
    >
      <ActionButton>添加心仪的店</ActionButton>
      {open && <EatAddDialog key={session} onAdded={onAdded} />}
    </DialogTrigger>
  );
}

function EatAddDialog({ onAdded }: { onAdded: (list: EatSubmission[]) => void }) {
  const [name, setName] = useState("");
  const [district, setDistrict] = useState("haeundae");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const trimmed = name.trim();
  return (
    <Dialog size="M">
      {({ close }) => (
        <>
          <Heading slot="title">添加心仪的店</Heading>
          <Content>
            <div className="eat-add">
              <p className="eat-hint">
                记下你想去的店,默认**只存在这台设备**;登录 IFFDAY 后会同步到你自己那份,别人看不到。
              </p>
              <TextField label="店名" placeholder="如 五福猪肉汤饭" value={name} onChange={setName} />
              <Picker label="分区" value={district} onChange={(v) => setDistrict(String(v))}>
                {Object.entries(DISTRICT_LABEL).map(([code, label]) => (
                  <PickerItem id={code} key={code}>
                    {label}
                  </PickerItem>
                ))}
              </Picker>
              <TextField
                label="地址（可留空，填了地图更好搜）"
                placeholder="如 부산 해운대구 구남로 28"
                value={address}
                onChange={setAddress}
              />
              <TextArea
                label="备注（可留空）"
                placeholder="朋友推荐、要排队、只收现金……"
                value={note}
                onChange={setNote}
              />
            </div>
          </Content>
          <ButtonGroup>
            <Button
              variant="accent"
              isDisabled={!trimmed}
              onPress={() => {
                onAdded(addSubmission({ name: trimmed, district, address: address.trim(), note: note.trim() }));
                ToastQueue.positive(`${trimmed} 已加到「吃喝」`);
                close();
              }}
            >
              添加
            </Button>
            <Button variant="secondary" onPress={close}>
              取消
            </Button>
          </ButtonGroup>
        </>
      )}
    </Dialog>
  );
}

export function EatsPage() {
  const { params, update } = useQuery();
  const [file, setFile] = useState<EatsFile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [subs, setSubs] = useState<EatSubmission[]>([]);
  // 本地键可能在别处被改(另一标签页、或账号同步把云端那份铺回来)→ 读写盘为准,不缓存副本
  useEffect(() => {
    setSubs(readSubmissions());
    const refresh = () => setSubs(readSubmissions());
    window.addEventListener("iffday:workspace-change", refresh);
    return () => window.removeEventListener("iffday:workspace-change", refresh);
  }, []);
  useEffect(() => {
    let alive = true;
    void loadEatsFile().then((data) => {
      if (!alive) return;
      setFile(data);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const query = useDeferredValue(params.get("q") ?? "");
  const district = params.get("district") ?? "all";
  const menu = params.get("menu") ?? "all";

  const { rows, districts, menus } = useMemo(() => {
    const shops = file?.shops ?? [];
    const all = [...subs.map(rowOfSubmission), ...shops.map(rowOfShop)];
    const districtCounts = new Map<string, number>();
    const menuCounts = new Map<string, number>();
    for (const row of all) {
      districtCounts.set(row.district, (districtCounts.get(row.district) ?? 0) + 1);
      if (row.menu) menuCounts.set(row.menu, (menuCounts.get(row.menu) ?? 0) + 1);
    }
    const needle = query.trim().toLowerCase();
    return {
      rows: all.filter(
        (row) => (district === "all" || row.district === district) && (menu === "all" || row.menu === menu) && hit(row, needle),
      ),
      districts: [...districtCounts.keys()].sort(
        (a, b) => (districtCounts.get(b) ?? 0) - (districtCounts.get(a) ?? 0),
      ),
      menus: [...menuCounts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key),
    };
  }, [file, subs, query, district, menu]);

  // 逐个查精确店铺页。**串行**是刻意的:40 家并发打上游没有意义(服务端本来就是逐条查),
  // 而且串行才能在第一个 503 之后立刻靠 `lookupDisabled()` 停下,不再白打 39 次。
  const lookupKeys = rows.map((row) => `${row.id}\u0000${row.lookupName}\u0000${row.lookupAddress}`);
  const [hits, setHits] = useState<Map<string, PlaceHit | null>>(new Map());
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (lookupDisabled()) return;
      const next = new Map<string, PlaceHit | null>();
      for (const key of lookupKeys) {
        if (!alive || lookupDisabled()) break;
        const [id, name, address] = key.split("\u0000");
        const hit = await lookupPlace(name, address);
        if (!hit) continue;
        next.set(id, hit);
        if (alive) setHits(new Map(next));
      }
    })();
    return () => {
      alive = false;
    };
    // `lookupKeys` 每次渲染都是新数组 → 用字符串做依赖,否则会无限重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupKeys.join("|")]);

  const notice = file?.notice ?? "";
  return (
    <section className="eats-page" aria-label="吃喝">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">电影节期间吃什么</p>
          <h1>吃喝</h1>
        </div>
        <span className="count" aria-live="polite">
          {rows.length} 家
        </span>
      </div>
      <div className="summary-strip">
        <span>
          清单来自剧组同事整理的《BIFF吃喝》表格{file?.generated_at ? `（${file.generated_at}）` : ""}
        </span>
        {subs.length > 0 && <span>其中 {subs.length} 家是你自己添加的</span>}
        <EatAddEntry onAdded={setSubs} />
      </div>
      {notice && <p className="eat-notice">{notice}</p>}
      <div className="eats-controls">
        <QuerySearchField
          label="搜索店铺"
          placeholder="店名、菜名、地址（中 / 한 / en 都可以）"
        />
        <div className="inline-fields">
          <Picker
            label="分区"
            value={district}
            onChange={(value) => update({ district: value === "all" ? null : String(value) })}
          >
            <PickerItem id="all">全部分区</PickerItem>
            {districts.map((code) => (
              <PickerItem id={code} key={code}>
                {districtLabel(code)}
              </PickerItem>
            ))}
          </Picker>
          <Picker
            label="想吃什么"
            value={menu}
            onChange={(value) => update({ menu: value === "all" ? null : String(value) })}
          >
            <PickerItem id="all">全部品类</PickerItem>
            {menus.map((item) => (
              <PickerItem id={item} key={item}>
                {item}
              </PickerItem>
            ))}
          </Picker>
        </div>
      </div>
      {rows.length > 0 ? (
        <ul className="eats-list">
          {rows.map((row) => (
            <EatCard
              row={row}
              key={row.id}
              hit={hits.get(row.id) ?? null}
              onRemove={row.mine ? (id) => setSubs(removeSubmission(id)) : undefined}
            />
          ))}
        </ul>
      ) : (
        <div className="empty-state">
          {!loaded ? (
            <h2>正在读清单…</h2>
          ) : (
            <>
              <h2>没有匹配的店</h2>
              <p>换个关键词或清掉筛选；也可以点上面的「添加心仪的店」把想去的记下来。</p>
            </>
          )}
        </div>
      )}
      <p className="eats-footnote">
        地图链接只是检索入口，营业时间以店里为准。数据文件：<code>public/eats.json</code>（键
        {" "}
        <code>{EATS_KEY}</code> 存你自己添加的店）。
      </p>
    </section>
  );
}
