import { describe, expect, it } from "vitest";
import {
  TICKET_COUNT_MAX,
  allSeatsBlank,
  defaultUnreserved,
  migrateTicketInfoV1,
  normalizeSeats,
  normalizeTicketAccount,
  normalizeTicketInfo,
  ticketBadgeText,
  ticketCountOf,
  ticketInfoTitle,
  totalTicketCount,
} from "../src/ticket-info";
import type { TicketInfo } from "../src/types";

// 票据明细(2026-09-24,PLAN-20260924141442)。纯逻辑,不碰 DOM / localStorage。
// ★ 本文件守的核心口径:**座位行数 = 票数**(用户「用添加的座位数作为票数」)——
//   所以「空行」不是噪声,它本身就是一张票,任何归一化都不许把它收掉。
// ★ 修订 4 追加:不划位 = **全空**的座位行(`allSeatsBlank` 判回),没有独立字段;
//   初始档位由 `defaultUnreserved` 给(露天场、非开闭幕)。
// ★ 修订 7 追加:账号名**不在** `TicketInfo` 上(它只存本机),本文件守住「读到也丢弃」这条。
//
// ⚠⚠ **本文件里的姓名 / 预约号 / 账号一律是假数据**(`ZHANGSAN` / `269EXAMPLE…`)。
//    这个仓库是**公开**的 —— 2026-09-24 曾把真实姓名与 17 个真实预约号写进测试与文档,
//    被用户发现后全部替换。**别再抄真实数据进来。**

describe("normalizeSeats", () => {
  it("★ 保位:空行留下(空行也是一张票),只截长度与行数", () => {
    expect(normalizeSeats(["F12"])).toEqual(["F12"]);
    // 尾部空行**必须**保留 —— 收掉它票数就从 2 变 1
    expect(normalizeSeats(["F12", ""])).toEqual(["F12", ""]);
    expect(normalizeSeats(["", "", ""])).toEqual(["", "", ""]);
    // 中间的空行同样保留(下标 = 第几张票)
    expect(normalizeSeats(["F12", "", "F14"])).toEqual(["F12", "", "F14"]);
  });

  it("逐项去首尾空白、超长截断(上限 32 —— 修订 5 从 12 提上来的)", () => {
    expect(normalizeSeats(["  F12  "])).toEqual(["F12"]);
    expect(normalizeSeats(["A".repeat(40)])).toEqual(["A".repeat(32)]);
  });

  it("★ BIFF 真实座号形态原样通过(带区/排前缀,最长 15 字符)", () => {
    // 上限曾是 12 —— 这些会被**静默截断**,实测用户导入的 17 笔里有 12 笔超长。
    for (const seat of ["Sec 7 · R2 S4", "Floor 3 · R1 S8", "Floor 1 · R8 S23", "Sec 가 · S143"]) {
      expect(normalizeSeats([seat])).toEqual([seat]);
    }
  });

  it("行数封顶,空表 → undefined", () => {
    const many = Array.from({ length: TICKET_COUNT_MAX + 5 }, () => "x");
    expect(normalizeSeats(many)).toHaveLength(TICKET_COUNT_MAX);
    expect(normalizeSeats([])).toBeUndefined();
    expect(normalizeSeats("F12")).toBeUndefined();
    expect(normalizeSeats(null)).toBeUndefined();
  });

  it("非字符串项按空行处理(不静默丢位置)", () => {
    expect(normalizeSeats(["F12", 3, null])).toEqual(["F12", "", ""]);
  });
});

describe("normalizeTicketInfo", () => {
  it("结构不对 / 没有座位行 → 整条丢弃(不留空壳记录)", () => {
    expect(normalizeTicketInfo(null)).toBeNull();
    expect(normalizeTicketInfo("F12")).toBeNull();
    expect(normalizeTicketInfo({})).toBeNull();
    expect(normalizeTicketInfo({ seats: [] })).toBeNull();
    expect(normalizeTicketInfo({ count: 3 })).toBeNull(); // 旧字段不再产生新记录
  });

  it("★ 全空行也是合法明细:两张票、座位都还没填", () => {
    expect(normalizeTicketInfo({ seats: ["", ""] })).toEqual({ seats: ["", ""] });
  });

  it("持票信息(修订 5):姓名 / 预约号原样保留", () => {
    expect(
      normalizeTicketInfo({
        seats: ["Sec 7 · R2 S4"],
        name: "ZHANGSAN",
        bookingNo: "269EXAMPLE0000001",
      }),
    ).toEqual({
      seats: ["Sec 7 · R2 S4"],
      name: "ZHANGSAN",
      bookingNo: "269EXAMPLE0000001",
    });
  });

  it("★ 修订 7:账号**不在**这个结构里 —— 读进来也一律丢弃(它该落本地键)", () => {
    // 这条守的是「账号名又被写回随片单上云的记录」这个回归。
    const record = normalizeTicketInfo({ seats: ["F12"], name: "ZHANGSAN", account: "leak" });
    expect(record).toEqual({ seats: ["F12"], name: "ZHANGSAN" });
    expect(record && "account" in record).toBe(false);
  });

  it("两个字段都去首尾空白;空 / 空白 / 非字符串一律**省略**(不留空串键)", () => {
    const record = normalizeTicketInfo({ seats: ["F12"], name: "  LISI  ", bookingNo: "   " });
    expect(record).toEqual({ seats: ["F12"], name: "LISI" });
    // 「省略」而不是 `{name: ""}` —— 空串会在存储里留噪声,也会让落盘等值判重失效
    expect(record && "bookingNo" in record).toBe(false);
  });

  it("超长字段截断(姓名上限 24 / 预约号上限 32)", () => {
    const record = normalizeTicketInfo({
      seats: ["F12"],
      name: "N".repeat(40),
      bookingNo: "B".repeat(40),
    });
    expect(record?.name).toHaveLength(24);
    expect(record?.bookingNo).toHaveLength(32);
  });

  it("★ v2 记录(只有 seats)读进来天然合法 —— v2 → v3 不需要单独的迁移函数", () => {
    expect(normalizeTicketInfo({ seats: ["F12", ""] })).toEqual({ seats: ["F12", ""] });
  });
});

describe("normalizeTicketAccount(修订 7:与票务家族同一套归一,但落本地键)", () => {
  it("去首尾空白、超长截断到 32", () => {
    expect(normalizeTicketAccount("  example-account  ")).toBe("example-account");
    expect(normalizeTicketAccount("A".repeat(40))).toHaveLength(32);
  });

  it("空 / 空白 / 非字符串 → undefined(空即「没填」,不写空串)", () => {
    expect(normalizeTicketAccount(undefined)).toBeUndefined();
    expect(normalizeTicketAccount("   ")).toBeUndefined();
    expect(normalizeTicketAccount(42)).toBeUndefined();
    expect(normalizeTicketAccount(null)).toBeUndefined();
  });
});

describe("migrateTicketInfoV1(旧结构 → 新结构)", () => {
  it("★ 按旧的 count 把座位行补齐到那么长(迁移的唯一语义)", () => {
    expect(migrateTicketInfoV1({ count: 3, seats: ["F12"] })).toEqual({
      seats: ["F12", "", ""],
    });
    expect(migrateTicketInfoV1({ count: 2 })).toEqual({ seats: ["", ""] });
  });

  it("座位行比 count 多时按行数走(不截断用户已经填过的东西)", () => {
    expect(migrateTicketInfoV1({ count: 1, seats: ["A", "B"] })).toEqual({ seats: ["A", "B"] });
  });

  it("★ 已撤销的账号方案:accountId 直接丢弃,不参与换算", () => {
    expect(migrateTicketInfoV1({ count: 1, accountId: "a1" })).toEqual({ seats: [""] });
  });

  it("没有可用信息 → null(count 非法且没有座位行)", () => {
    expect(migrateTicketInfoV1(null)).toBeNull();
    expect(migrateTicketInfoV1({})).toBeNull();
    expect(migrateTicketInfoV1({ count: 0 })).toBeNull();
    expect(migrateTicketInfoV1({ count: "2" })).toBeNull();
  });

  it("count 超上限 → 行数封顶", () => {
    expect(migrateTicketInfoV1({ count: 999 })?.seats).toHaveLength(TICKET_COUNT_MAX);
  });
});

describe("ticketCountOf / ticketBadgeText(票数 = 行数)", () => {
  it("没明细 → undefined(与「0 张」区分开)", () => {
    expect(ticketCountOf(undefined)).toBeUndefined();
    expect(ticketCountOf({})).toBeUndefined();
    expect(ticketCountOf({ seats: [] })).toBeUndefined();
  });

  it("行数即张数,空行照样算", () => {
    expect(ticketCountOf({ seats: ["F12"] })).toBe(1);
    expect(ticketCountOf({ seats: ["F12", ""] })).toBe(2);
    expect(ticketCountOf({ seats: ["", "", ""] })).toBe(3);
  });

  it("徽章只在有明细时给文案 —— 没明细就不渲染", () => {
    expect(ticketBadgeText(undefined)).toBeNull();
    expect(ticketBadgeText({})).toBeNull();
    expect(ticketBadgeText({ seats: ["", ""] })).toBe("2 张");
  });
});

describe("totalTicketCount(「共 N 张票」的唯一口径)", () => {
  it("已抢到的场次 ∪ 有明细的场次;没明细的按 1 张", () => {
    const got = new Set(["001", "002"]);
    const info = new Map<string, TicketInfo>([
      ["002", { seats: ["", "", ""] }],
      ["003", { seats: ["F12", ""] }],
    ]);
    // 001 → 1(已抢到,没明细);002 → 3(三行);003 → 2(没标已抢到,但加过行)
    expect(totalTicketCount(got, info)).toBe(6);
  });

  it("只标三态的老用户 → 数字与「实际 N 场」一致", () => {
    expect(totalTicketCount(new Set(["001", "002", "003"]), new Map())).toBe(3);
  });

  it("什么都没有 → 0", () => {
    expect(totalTicketCount(new Set(), new Map())).toBe(0);
  });
});

describe("ticketInfoTitle", () => {
  it("按「几张 / 坐哪」印;没填座位的那些跳过,不印一串占位符", () => {
    expect(ticketInfoTitle({ seats: ["12", "", "14"] })).toBe("3 张，座位 第 1 张 12 / 第 3 张 14");
  });

  it("一个座位都没填时明说「座位未填」(不再只报张数)", () => {
    expect(ticketInfoTitle({ seats: ["", ""] })).toBe("2 张，座位未填");
  });

  it("没有明细 → 明说,而不是空字符串", () => {
    expect(ticketInfoTitle(undefined)).toBe("还没有填写票务信息");
  });

  it("★ 预约号排在姓名前面(换票窗口要先看那串号);账号名最后", () => {
    expect(
      ticketInfoTitle(
        {
          seats: ["Floor 3 · R1 S8", "Floor 3 · R1 S9"],
          name: "LISI",
          bookingNo: "269EXAMPLE0000003",
        },
        "example-account",
      ),
    ).toBe(
      "2 张，座位 第 1 张 Floor 3 · R1 S8 / 第 2 张 Floor 3 · R1 S9，预约号 269EXAMPLE0000003，LISI，账号 example-account",
    );
  });

  it("★ 账号是**第二个参数**,不是 `TicketInfo` 上的字段(修订 7:它只存本机)", () => {
    expect(ticketInfoTitle({ seats: ["F12"], name: "ZHANGSAN" })).toBe(
      "1 张，座位 第 1 张 F12，ZHANGSAN",
    );
    // 传空串 = 本机没记账号 → 不印「账号 」半句
    expect(ticketInfoTitle({ seats: ["F12"], name: "ZHANGSAN" }, "")).toBe(
      "1 张，座位 第 1 张 F12，ZHANGSAN",
    );
  });

  it("只填了持票信息、没座号(不划位场次)→ 座位未填 + 后两项照印", () => {
    expect(
      ticketInfoTitle({ seats: ["", ""], name: "ZHANGSAN", bookingNo: "269EXAMPLE0000002" }),
    ).toBe("2 张，座位未填，预约号 269EXAMPLE0000002，ZHANGSAN");
  });
});

describe("allSeatsBlank(「不划位」的判据)", () => {
  it("★ 全空 = 不划位(自由入座的落库形态)", () => {
    expect(allSeatsBlank({ seats: ["", ""] })).toBe(true);
    expect(allSeatsBlank({ seats: ["", "", ""] })).toBe(true);
  });

  it("只要有一张填过座位号 → 不是不划位(那场是划位的)", () => {
    expect(allSeatsBlank({ seats: ["F12"] })).toBe(false);
    expect(allSeatsBlank({ seats: ["", "F13"] })).toBe(false);
  });

  it("★ 没有票就不谈档位:没明细 / 空数组 → false(别把「还没记」误判成不划位)", () => {
    expect(allSeatsBlank(undefined)).toBe(false);
    expect(allSeatsBlank({})).toBe(false);
    expect(allSeatsBlank({ seats: [] })).toBe(false);
  });
});

describe("defaultUnreserved(初始档位的常识默认)", () => {
  it("★ 露天场(bt)默认不划位 —— 本届 Open Cinema 8 场都在那儿", () => {
    expect(defaultUnreserved("bt", [])).toBe(true);
  });

  it("★ 露天场的开闭幕**不**默认不划位:001/002 也在 bt,但那是典礼场(固定座席)", () => {
    expect(defaultUnreserved("bt", ["opening"])).toBe(false);
    expect(defaultUnreserved("bt", ["closing"])).toBe(false);
  });

  it("非露天场一律默认划位(含未知场馆 id —— 猜错成自由入座会让人以为座位号丢了)", () => {
    expect(defaultUnreserved("b1", [])).toBe(false);
    expect(defaultUnreserved("c5", [])).toBe(false);
    expect(defaultUnreserved("", [])).toBe(false);
    expect(defaultUnreserved("unknown", [])).toBe(false);
  });
});
