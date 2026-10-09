import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { guestScreening, readGuest } from "../src/guest";

const date = "2026-10-09";
const now = Date.parse("2026-10-09T08:00:00+09:00");
const item = { sdCode: "222", prodSeq: 3000001823, sdDate: "2026.10.09 (Fri)", sdTime: "16:20",
  perfMainNm: "Fixture", venueNm: "Cinema", hallNm: "3", remainSeat: 3, saleStatus: "ING", saleStatusCd: "SALE" };
const env = { APP_ENV: "local", APP_ORIGIN: "http://localhost", IFFDAY_ORIGIN: "http://127.0.0.1",
  OIDC_CLIENT_ID: "fixture", OIDC_CLIENT_SECRET: "x".repeat(32), SESSION_SECRET: "x".repeat(32) } as unknown as Env;
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("GUEST 官方库存", () => {
  it("普通票路由只查询 WEB 库存并保留数量，不读取 GUEST", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ dateList: [{ sdStartDt: date }] }))
      .mockResolvedValueOnce(json({ prodList: [{ ...item, remainSeat: 27 }] }));
    vi.stubGlobal("fetch", fetcher);
    const response = await app.request(`http://localhost/api/general?date=${date}`, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ screenings: [{ remaining: 27 }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url] of fetcher.mock.calls) expect(new URL(url).searchParams.get("chnlCd")).toBe("WEB");
  });
  it("普通票坏日期不请求上游，故障返回普通票错误而非零库存", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("timeout"));
    vi.stubGlobal("fetch", fetcher);
    expect((await app.request("http://localhost/api/general?date=2026-02-30", {}, env)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await app.request(`http://localhost/api/general?date=${date}`, {}, env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "GENERAL_UPSTREAM_FAILED" });
  });
  it.each([null, undefined, "", -1, "garbage", true, 1.5])("未知库存 %s 不转换为零", (remainSeat) => {
    expect(guestScreening({ ...item, remainSeat }, date, now)).toMatchObject({ remaining: null, status: "unknown" });
  });
  it("区分已结束、未开售、售罄与有票", () => {
    expect(guestScreening(item, date, now)).toMatchObject({ remaining: 3, status: "available" });
    expect(guestScreening({ ...item, remainSeat: 0 }, date, now)?.status).toBe("sold_out");
    expect(guestScreening({ ...item, saleStatus: "WAIT" }, date, now)?.status).toBe("not_open");
    expect(guestScreening({ ...item, saleStatusCd: "SALEEND" }, date, now)?.status).toBe("ended");
    expect(guestScreening(item, date, now + 86_400_000)?.status).toBe("ended");
    expect(guestScreening({ ...item, saleStatusCd: "SOLDOUT" }, date, now)?.status).toBe("sold_out");
  });
  it("保留 24+ 时刻且拒绝跨日误配", () => {
    expect(guestScreening({ ...item, sdTime: "29:35" }, date, now + 86_400_000 - 4 * 3_600_000))
      .toMatchObject({ time: "29:35", status: "available" });
    expect(guestScreening(item, "2026-10-10", now)).toBeNull();
  });
  it("未开放日期只查询日期端点", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ dateList: [{ sdStartDt: "2026-10-10" }] }));
    expect(await readGuest(date, fetcher, now)).toMatchObject({ dateOpen: false, screenings: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("服务端只请求官方 GUEST 两个只读端点且不带凭据", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ dateList: [{ sdStartDt: date }] }))
      .mockResolvedValueOnce(json({ prodList: [item] }));
    expect((await readGuest(date, fetcher, now)).screenings).toHaveLength(1);
    for (const [url, options] of fetcher.mock.calls) {
      expect(new URL(url).origin).toBe("https://filmapi.maketicket.co.kr");
      expect(new URL(url).searchParams.get("chnlCd")).toBe("GUEST");
      expect(options.method).toBeUndefined();
      expect(new Headers(options.headers).has("Cookie")).toBe(false);
      expect(options.redirect).toBe("manual");
    }
  });
  it("官方错误及畸形列表均失败，不伪装成售罄", async () => {
    for (const body of [{ resultCode: "9999" }, { dateList: null }, { dateList: [{ sdStartDt: "2026-02-30" }] }]) {
      await expect(readGuest(date, vi.fn().mockResolvedValue(json(body)), now)).rejects.toThrow();
    }
    const fetcher = vi.fn().mockResolvedValueOnce(json({ dateList: [{ sdStartDt: date }] })).mockResolvedValueOnce(json({ prodList: [null] }));
    await expect(readGuest(date, fetcher, now)).rejects.toThrow();
  });
  it("使用 Workers 支持的手动重定向且拒绝 302，不访问跳转目标", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: "https://example.invalid/" } }));
    await expect(readGuest(date, fetcher, now)).rejects.toThrow("GUEST_UPSTREAM_FAILED");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].redirect).toBe("manual");
  });
  it("路由免登录、拒绝坏日期，并将上游故障转成 502", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ dateList: [] }));
    vi.stubGlobal("fetch", fetcher);
    expect((await app.request("http://localhost/api/guest?date=2026-02-30", {}, env)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await app.request(`http://localhost/api/guest?date=${date}`, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    fetcher.mockRejectedValue(new Error("timeout"));
    expect((await app.request(`http://localhost/api/guest?date=${date}`, {}, env)).status).toBe(502);
  });
});
