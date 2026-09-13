import { describe, expect, it } from "vitest";
import { encode, hash, randomToken, seal, unseal } from "../src/crypto";

// `src/crypto.ts` 是账号体系的**信任根**:OAuth pending 事务与 session token 都靠
// `seal/unseal`(AES-GCM + purpose 绑定)保护。它此前只有 `e2e/account.spec.ts` 一条端到端覆盖 ——
// 而端到端绿了**不代表**「用错 purpose 会失败」被验证过。
//
// 这些是纯函数(WebCrypto / atob / btoa 在 Node 24 都是全局),不需要任何 mock。
// 2026-09-13 补,见 PLAN-20260913201727。

const SECRET = "unit-test-secret-at-least-32-chars";

describe("encode", () => {
  it("产出 base64url:无 + / =,只有 A-Za-z0-9_-", () => {
    // 覆盖会撞上 + / = 的字节组合
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00, 0x3e, 0x3f]);
    const encoded = encode(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("=");
  });
});

describe("randomToken", () => {
  it("32 字节 → 43 个 base64url 字符(去掉 1 个 = 填充)", () => {
    expect(randomToken()).toHaveLength(43);
  });

  it("两次调用不同", () => {
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe("hash", () => {
  it("同输入同输出(SHA-256 → base64url,43 字符)", async () => {
    const first = await hash("biff");
    expect(first).toBe(await hash("biff"));
    expect(first).toHaveLength(43);
  });

  it("不同输入不同输出", async () => {
    expect(await hash("biff")).not.toBe(await hash("biff "));
  });
});

describe("seal / unseal", () => {
  it("往返还原原值(对象 / 数组 / 基本类型)", async () => {
    for (const value of [{ a: 1, b: ["x"] }, [1, 2, 3], "text", 42, null]) {
      expect(await unseal(await seal(value, SECRET, "purpose"), SECRET, "purpose")).toEqual(value);
    }
  });

  it("密文形如 <iv>.<body>,每次 seal 都不同(IV 随机)", async () => {
    const first = await seal({ a: 1 }, SECRET, "purpose");
    const second = await seal({ a: 1 }, SECRET, "purpose");
    expect(first).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
  });

  it("★ purpose 是绑定的:换一个 purpose 解不开", async () => {
    // 这是把 pending 事务(oauth:)与 session(session:)隔开的唯一机制 ——
    // 若这条失守,一个 cookie 的密文就能被拿去当另一个用途用。
    const sealed = await seal({ state: "s" }, SECRET, "oauth:abc");
    await expect(unseal(sealed, SECRET, "session:abc")).rejects.toThrow();
  });

  it("★ secret 不同解不开", async () => {
    const sealed = await seal({ state: "s" }, SECRET, "purpose");
    await expect(unseal(sealed, "another-secret-at-least-32-characters", "purpose")).rejects.toThrow();
  });

  it("secret 少于 32 字符直接抛错(不静默降级)", async () => {
    await expect(seal({ a: 1 }, "short", "purpose")).rejects.toThrow("Missing session encryption key");
  });

  it("缺少 . 分隔符时抛 Invalid encrypted session", async () => {
    await expect(unseal("no-separator", SECRET, "purpose")).rejects.toThrow("Invalid encrypted session");
  });

  it("密文被篡改则解不开(AES-GCM 完整性)", async () => {
    const sealed = await seal({ a: 1 }, SECRET, "purpose");
    const [iv, body] = sealed.split(".");
    const tampered = `${iv}.${body.slice(0, -1)}${body.at(-1) === "A" ? "B" : "A"}`;
    await expect(unseal(tampered, SECRET, "purpose")).rejects.toThrow();
  });
});
