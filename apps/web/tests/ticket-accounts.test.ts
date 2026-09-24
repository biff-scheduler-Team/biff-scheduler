import { describe, expect, it } from "vitest";
import {
  TICKET_ACCOUNTS_KEY,
  accountLabelOf,
  normalizeAccountsFile,
  readTicketAccounts,
  resolveAccountOf,
  writeTicketAccounts,
  type AccountStorage,
} from "../src/ticket-accounts";
import type { TicketAccount } from "../src/types";

// BIFF 票务账号表(2026-09-24,PLAN-20260924141442)。纯逻辑 + 内存存储替身(node 没有 localStorage)。
// ★ 本文件守的**核心不变量**只有一条:这只键叫 `iffday.workspace.*`,不叫 `biff.*` ——
//   叫后者就会被账号云同步上传、并被写进可分享的「导出数据备份」(见 ticket-accounts.ts 文件头)。

function memoryStorage(seed: Record<string, string> = {}): AccountStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

describe("键名契约", () => {
  it("落在 iffday 命名空间,绝不能是 biff.(落了 biff. 就会被上传云端 + 进备份文件)", () => {
    expect(TICKET_ACCOUNTS_KEY.startsWith("iffday.workspace.")).toBe(true);
    expect(TICKET_ACCOUNTS_KEY.startsWith("biff.")).toBe(false);
  });
});

describe("normalizeAccountsFile", () => {
  it("丢掉没有 id / 没有用户名的账号(空壳账号没有任何可用信息)", () => {
    const file = normalizeAccountsFile({
      accounts: [
        { id: "a1", label: "主号", username: "me@example.com", password: "p" },
        { id: "", username: "no-id@example.com" },
        { id: "a2", username: "   " },
        "nope",
        null,
      ],
    });
    expect(file.accounts.map((a) => a.id)).toEqual(["a1"]);
  });

  it("同一 id 只留第一条", () => {
    const file = normalizeAccountsFile({
      accounts: [
        { id: "a1", username: "first@example.com" },
        { id: "a1", username: "second@example.com" },
      ],
    });
    expect(file.accounts.map((a) => a.username)).toEqual(["first@example.com"]);
  });

  it("★ defaultId 指向不存在的账号 → 归一成 null(不留一个指向空气的 id)", () => {
    expect(normalizeAccountsFile({ accounts: [], defaultId: "ghost" }).defaultId).toBeNull();
    expect(
      normalizeAccountsFile({
        accounts: [{ id: "a1", username: "me@example.com" }],
        defaultId: "a1",
      }).defaultId,
    ).toBe("a1");
  });

  it("字段裁剪;密码允许为空串(= 用户选择不保存密码)", () => {
    const file = normalizeAccountsFile({
      accounts: [{ id: "a1", label: "L".repeat(50), username: "u@e.com", password: "" }],
    });
    expect(file.accounts[0].label).toHaveLength(24);
    expect(file.accounts[0].password).toBe("");
  });

  it("整体不是对象 → 空表", () => {
    expect(normalizeAccountsFile(null)).toEqual({ accounts: [], defaultId: null });
    expect(normalizeAccountsFile("x")).toEqual({ accounts: [], defaultId: null });
  });
});

describe("readTicketAccounts / writeTicketAccounts", () => {
  it("半截 JSON 一律降级成空表,不让解析异常冒出去", () => {
    const storage = memoryStorage({ [TICKET_ACCOUNTS_KEY]: "{oops" });
    expect(readTicketAccounts(storage)).toEqual({ accounts: [], defaultId: null });
  });

  it("没有这只键 → 空表", () => {
    expect(readTicketAccounts(memoryStorage())).toEqual({ accounts: [], defaultId: null });
  });

  it("★ 空表落盘 = **删键**(而不是写一个空壳对象,localStorage 只增不减)", () => {
    const storage = memoryStorage();
    writeTicketAccounts(storage, { accounts: [], defaultId: null });
    expect(storage.dump()).toEqual({});
  });

  it("写进去再读回来形状一致", () => {
    const storage = memoryStorage();
    writeTicketAccounts(storage, {
      accounts: [{ id: "a1", label: "主号", username: "me@example.com", password: "pw" }],
      defaultId: "a1",
    });
    expect(readTicketAccounts(storage)).toEqual({
      accounts: [{ id: "a1", label: "主号", username: "me@example.com", password: "pw" }],
      defaultId: "a1",
    });
  });
});

const account = (id: string, label: string): TicketAccount => ({ id, label, username: `${id}@e.com`, password: "" });

describe("resolveAccountOf(票里单独设置优先,否则按默认账号)", () => {
  const file = { accounts: [account("a1", "主号"), account("a2", "朋友号")], defaultId: "a1" };

  it("没有覆盖 → 默认账号", () => {
    expect(resolveAccountOf(file, undefined)?.id).toBe("a1");
    expect(resolveAccountOf(file, {})?.id).toBe("a1");
  });

  it("有覆盖 → 覆盖的那个", () => {
    expect(resolveAccountOf(file, { accountId: "a2" })?.id).toBe("a2");
  });

  it("★ 覆盖的 id 在本机不存在(换设备同步过来的 / 账号已删)→ 回落默认账号", () => {
    expect(resolveAccountOf(file, { accountId: "ghost" })?.id).toBe("a1");
  });

  it("没有默认账号 → null(仍可记录张数与座位,只是没有可复制的凭据)", () => {
    expect(resolveAccountOf({ accounts: file.accounts, defaultId: null }, undefined)).toBeNull();
  });
});

describe("accountLabelOf", () => {
  it("label 优先,空则回落用户名", () => {
    expect(accountLabelOf(account("a1", "主号"))).toBe("主号");
    expect(accountLabelOf({ id: "a2", label: "", username: "x@e.com", password: "" })).toBe("x@e.com");
  });

  it("两者都空(只可能是还没保存的草稿)→ 占位名,不留一个空白选项", () => {
    expect(accountLabelOf({ id: "a3", label: "", username: "", password: "" })).toBe("未命名账号");
  });
});
