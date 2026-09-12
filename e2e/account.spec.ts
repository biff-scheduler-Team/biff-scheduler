import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
const origin = process.env.BIFF_TEST_ORIGIN ?? "http://localhost:31028";
const identityOrigin = process.env.IFFDAY_TEST_ORIGIN ?? "http://127.0.0.1:5183";
const password = "Cinema-account-integration-2026!";
const schedule = JSON.parse(readFileSync("apps/web/public/schedule.json", "utf8")) as {
  screenings: { code: string; title_en: string }[];
};
const films = JSON.parse(readFileSync("apps/web/public/films.json", "utf8")) as {
  films: { id: string; title_en?: string }[];
};
const screening = schedule.screenings[0]!;
const film = films.films.find((item) => item.title_en === screening.title_en);
const key = film ? `cat:${film.id}` : `sched:${screening.title_en.toLowerCase()}`;
const record = `pick:${key}`;
const initial = [{ key, picks: [{ code: screening.code }], note: "My original local note" }];
const ip = () => {
  const bytes = randomBytes(3);
  return `10.${bytes[0]}.${bytes[1]}.${bytes[2]}`;
};
const email = () => `integration-${randomUUID()}@iff-day.test`;
async function seedGuest(page: Page, note = initial[0]!.note) {
  await page.addInitScript(
    ({ origin, initial }) => {
      if (location.origin === origin && !sessionStorage.getItem("integration-seeded")) {
        localStorage.setItem("biff.picks.v2", JSON.stringify(initial));
        localStorage.setItem(
          "biff.settings.v1",
          JSON.stringify({ transitMin: 15, alarmMin: 30, gvTalkOn: true, gvTalkMin: 25 }),
        );
        sessionStorage.setItem("integration-seeded", "yes");
      }
    },
    { origin, initial: initial.map((row) => ({ ...row, note })) },
  );
}
async function finishConsent(page: Page) {
  await expect
    .poll(() => new URL(page.url()).hostname + new URL(page.url()).pathname)
    .toMatch(/(127\.0\.0\.1\/consent|localhost\/)/);
  if (new URL(page.url()).hostname === "127.0.0.1") {
    await expect(page.getByRole("heading", { name: "Continue to BIFF Scheduler" })).toBeVisible();
    await page.getByRole("button", { name: "Allow and continue", exact: true }).click();
  }
  await page.waitForURL((url) => url.origin === origin && url.pathname === "/");
  await expect
    .poll(async () => (await page.request.get(`${origin}/api/account/me`)).status())
    .toBe(200);
}
async function registerFromBiff(page: Page, userEmail: string, force = false) {
  await page.goto(`${origin}/api/auth/login${force ? "?prompt=login" : ""}`);
  await page.waitForURL((url) => url.origin === identityOrigin && url.pathname === "/login");
  await page.getByRole("link", { name: "Create an account", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/signup");
  await page.getByLabel("Email address", { exact: true }).fill(userEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await finishConsent(page);
}
async function loginFromBiff(page: Page, userEmail: string) {
  await page.goto(`${origin}/api/auth/login?prompt=login`);
  await page.waitForURL((url) => url.origin === identityOrigin && url.pathname === "/login");
  await page.getByLabel("Email address", { exact: true }).fill(userEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await finishConsent(page);
}
async function waitSynced(page: Page) {
  await expect(page.locator("#account-sync-status")).toHaveText("已同步");
}
async function closePanel(page: Page) {
  const dialog = page.getByRole("dialog", { name: "IFFDAY 账号" });
  if (await dialog.isVisible()) await page.keyboard.press("Escape");
}
async function contextFor(browser: NonNullable<ReturnType<BrowserContext["browser"]>>, ip: string) {
  return browser.newContext({ baseURL: origin, extraHTTPHeaders: { "cf-connecting-ip": ip } });
}

test("OIDC login migrates local data, syncs a second device and edits the global profile", async ({
  page,
  context,
  browser,
}, info) => {
  const userEmail = email();
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip() });
  await seedGuest(page);
  await page.goto("/");
  await expect(page.locator("#account-btn")).toBeVisible();
  await registerFromBiff(page, userEmail);
  await waitSynced(page);
  const identity = await (await page.request.get("/api/account/me")).json();
  const stored = await (await page.request.get("/api/account/sync/biff-2026")).json();
  expect(JSON.parse(stored.records[record]).note).toBe(initial[0]!.note);
  expect(JSON.parse(stored.records["local:biff.settings.v1"]).transitMin).toBe(15);
  const cookies = await context.cookies(origin);
  expect(cookies.find((cookie) => cookie.name === "biff.session")).toMatchObject({
    domain: "localhost",
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
  });
  expect(await page.evaluate(() => document.cookie)).not.toContain("biff.session");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toMatch(
    /access_token|refresh_token|id_token|client_secret/,
  );
  await page.getByLabel("显示名称", { exact: true }).fill("Cinema Friend");
  await page.getByLabel("简介", { exact: true }).fill("For the love of cinema.");
  await page.getByLabel("头像", { exact: true }).setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#c7212c";
        ctx.fillRect(0, 0, 64, 64);
        return canvas.toDataURL("image/png").split(",")[1]!;
      }),
      "base64",
    ),
  });
  await expect(
    page.getByText("头像已准备好，保存后会更新到 IFFDAY。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存个人资料", exact: true }).click();
  await expect(page.getByText("IFFDAY 个人资料已更新。", { exact: true })).toBeVisible();
  const global = await (await page.request.get(`${identityOrigin}/api/v1/me`)).json();
  expect(global.profile).toMatchObject({
    displayName: "Cinema Friend",
    bio: "For the love of cinema.",
  });
  expect(global.profile.avatarUrl).toMatch(/\/api\/v1\/avatars\//);
  expect((await page.request.get(global.profile.avatarUrl)).status()).toBe(200);
  await closePanel(page);
  await page.locator("#account-btn").click();
  const savedAvatar = page
    .getByRole("dialog", { name: "IFFDAY 账号" })
    .getByRole("img", { name: "账号头像" });
  await expect(savedAvatar).toHaveAttribute("src", global.profile.avatarUrl);
  await expect
    .poll(() => savedAvatar.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(512);
  const outdated = await page.request.patch("/api/account/profile", {
    headers: { origin },
    data: { displayName: "Outdated edit", bio: "", expectedVersion: 0 },
  });
  expect(outdated.status()).toBe(409);
  await page.screenshot({ path: info.outputPath("account-profile.png"), fullPage: true });

  const second = await contextFor(browser, ip());
  try {
    const other = await second.newPage();
    await loginFromBiff(other, userEmail);
    await waitSynced(other);
    expect(
      await other.evaluate(() => JSON.parse(localStorage.getItem("biff.picks.v2") ?? "[]")[0].note),
    ).toBe(initial[0]!.note);
    await closePanel(other);
    await second.setOffline(true);
    await other.evaluate(
      ({ key }) => {
        const picks = JSON.parse(localStorage.getItem("biff.picks.v2") ?? "[]");
        picks.find((pick: { key: string }) => pick.key === key).note =
          "Offline note from device two";
        localStorage.setItem("biff.picks.v2", JSON.stringify(picks));
        window.dispatchEvent(new Event("iffday:workspace-change"));
      },
      { key },
    );
    await expect(other.locator("#account-sync-status")).toHaveText("离线，修改保存在本机");
    await second.setOffline(false);
    await other.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitSynced(other);
    await closePanel(page);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await waitSynced(page);
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem("biff.picks.v2") ?? "[]")[0].note),
      )
      .toBe("Offline note from device two");

    // A deletion on one device must not be resurrected by an unchanged older device.
    await other.evaluate(() => {
      localStorage.setItem("biff.picks.v2", "[]");
      window.dispatchEvent(new Event("iffday:workspace-change"));
    });
    await waitSynced(other);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect
      .poll(() =>
        page.evaluate(() => JSON.parse(localStorage.getItem("biff.picks.v2") ?? "[]").length),
      )
      .toBe(0);
  } finally {
    await second.close();
  }
  const malicious = await page.request.put("/api/account/sync/biff-2026", {
    headers: { origin },
    data: {
      subject: "user_00000000000000000000000000",
      revision: 0,
      operationId: randomUUID(),
      records: {},
    },
  });
  expect(malicious.status()).toBe(409);
  const csrf = await page.request.patch("/api/account/profile", {
    headers: { origin: "https://attacker.example" },
    data: { displayName: "Attacker", bio: "" },
  });
  expect(csrf.status()).toBe(403);
  await page.locator("#account-btn").click();
  await page.getByRole("button", { name: "退出账号", exact: true }).click();
  await expect(page.locator("#account-btn")).toHaveText("登录 IFFDAY");
  expect((await page.request.get("/api/account/me")).status()).toBe(401);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("biff.picks.v2") ?? "[]")),
  ).toEqual([]);
  expect(identity.user.id).toMatch(/^user_/);
});

test("switching accounts keeps local and cloud data isolated", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip() });
  await seedGuest(page);
  await page.goto("/");
  const firstEmail = email();
  await registerFromBiff(page, firstEmail);
  await waitSynced(page);
  const first = await (await page.request.get("/api/account/me")).json();
  await registerFromBiff(page, email(), true);
  await waitSynced(page);
  const second = await (await page.request.get("/api/account/me")).json();
  expect(second.user.id).not.toBe(first.user.id);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("biff.picks.v2") ?? "[]")),
  ).toEqual([]);
  expect(
    (await (await page.request.get("/api/account/sync/biff-2026")).json()).records,
  ).not.toHaveProperty(record);
  await loginFromBiff(page, firstEmail);
  await waitSynced(page);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("biff.picks.v2") ?? "[]")[0].note),
  ).toBe(initial[0]!.note);
});

test("conflicting offline edits are reviewable and sync writes use revisions", async ({
  page,
  context,
  browser,
}, info) => {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip() });
  const userEmail = email();
  await seedGuest(page);
  await page.goto("/");
  await registerFromBiff(page, userEmail);
  await waitSynced(page);
  await closePanel(page);
  const second = await contextFor(browser, ip());
  try {
    const other = await second.newPage();
    await loginFromBiff(other, userEmail);
    await waitSynced(other);
    await closePanel(other);
    await second.setOffline(true);
    await other.evaluate(() => {
      const rows = JSON.parse(localStorage.getItem("biff.picks.v2")!);
      rows[0].note = "Offline draft";
      localStorage.setItem("biff.picks.v2", JSON.stringify(rows));
      window.dispatchEvent(new Event("iffday:workspace-change"));
    });
    await page.evaluate(() => {
      const rows = JSON.parse(localStorage.getItem("biff.picks.v2")!);
      rows[0].note = "Cloud draft";
      localStorage.setItem("biff.picks.v2", JSON.stringify(rows));
      window.dispatchEvent(new Event("iffday:workspace-change"));
    });
    await waitSynced(page);
    await second.setOffline(false);
    await other.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(other.locator("#account-sync-status")).toHaveText("有修改需要确认");
    await other.locator("#account-btn").click();
    const dialog = other.getByRole("dialog", { name: "IFFDAY 账号" });
    await expect(dialog.getByText(/本机：.*Offline draft/)).toBeVisible();
    await expect(dialog.getByText(/云端数据：.*Cloud draft/)).toBeVisible();
    await other.screenshot({ path: info.outputPath("sync-conflict.png"), fullPage: true });
    await dialog.getByRole("combobox").selectOption("remote");
    await dialog.getByRole("button", { name: "确认选择并同步", exact: true }).click();
    await waitSynced(other);
    expect(
      await other.evaluate(() => JSON.parse(localStorage.getItem("biff.picks.v2")!)[0].note),
    ).toBe("Cloud draft");
  } finally {
    await second.close();
  }
  const me = await (await page.request.get("/api/account/me")).json();
  const base = await (await page.request.get("/api/account/sync/biff-2026")).json();
  const operation = {
    subject: me.user.id,
    revision: base.revision,
    operationId: randomUUID(),
    records: base.records,
  };
  expect(
    (
      await page.request.put("/api/account/sync/biff-2026", {
        headers: { origin },
        data: operation,
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.put("/api/account/sync/biff-2026", {
        headers: { origin },
        data: operation,
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.put("/api/account/sync/biff-2026", {
        headers: { origin },
        data: { ...operation, operationId: randomUUID() },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await page.request.put("/api/account/sync/biff-2026", {
        headers: { origin },
        data: { ...operation, records: {} },
      })
    ).status(),
  ).toBe(409);
});

test("declining authorization preserves the guest workspace", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip() });
  await seedGuest(page);
  await page.goto("/");
  await page.goto(`${origin}/api/auth/login`);
  await page.waitForURL((url) => url.pathname === "/login");
  await page.getByRole("link", { name: "Create an account", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/signup");
  await page.getByLabel("Email address", { exact: true }).fill(email());
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForURL((url) => url.origin === origin && url.pathname === "/");
  expect((await page.request.get("/api/account/me")).status()).toBe(401);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("biff.picks.v2")!)[0].note),
  ).toBe(initial[0]!.note);
});

test("concurrent requests refresh the server-side token without exposing it", async ({
  page,
  context,
}) => {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip() });
  await registerFromBiff(page, email());
  await waitSynced(page);
  const identity = await (await page.request.get("/api/account/me")).json();
  const directory = resolve("apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  let updated = 0;
  for (const filename of readdirSync(directory).filter(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  )) {
    const database = new DatabaseSync(resolve(directory, filename));
    database.exec("PRAGMA busy_timeout=5000");
    try {
      updated += Number(
        database
          .prepare("UPDATE app_session SET token_expires_at = 0 WHERE subject = ?")
          .run(identity.user.id).changes,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("no such table")) throw error;
    } finally {
      database.close();
    }
  }
  expect(updated).toBeGreaterThan(0);
  const responses = await Promise.all([
    page.request.get("/api/account/me"),
    page.request.get("/api/account/me"),
    page.request.get("/api/account/me"),
  ]);
  for (const response of responses) {
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.user.id).toBe(identity.user.id);
    expect(JSON.stringify(data)).not.toMatch(/accessToken|refreshToken|idToken/);
  }
});

test("empty storage does not claim import; nonempty data imports once across devices and logins", async ({ page, context, browser }) => {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip() });
  const userEmail = email();
  await registerFromBiff(page, userEmail);
  await waitSynced(page);
  const blank = await (await page.request.get("/api/account/sync/biff-2026")).json();
  expect(blank.importedAt).toBeNull();
  const emptyAttempt = await page.request.post("/api/account/import", {
    headers: { Origin: origin },
    data: { subject: blank.subject, revision: blank.revision, operationId: randomUUID(), records: {}, sourceRecords: { "local:biff.gvtalk.v1": "{}", "local:biff.picks.v2": "[]" } },
  });
  expect(emptyAttempt.status()).toBe(422);
  expect((await emptyAttempt.json()).error).toBe("EMPTY_IMPORT");
  expect((await (await page.request.get("/api/account/sync/biff-2026")).json()).importedAt).toBeNull();
  const sourceDevice = await contextFor(browser, ip());
  const laterDevice = await contextFor(browser, ip());
  try {
    const sourcePage = await sourceDevice.newPage();
    await seedGuest(sourcePage, "First device data");
    await sourcePage.goto("/");
    await loginFromBiff(sourcePage, userEmail);
    await waitSynced(sourcePage);
    const imported = await (await sourcePage.request.get("/api/account/sync/biff-2026")).json();
    expect(imported.importedAt).toEqual(expect.any(Number));
    expect(JSON.parse(imported.records[record]).note).toBe("First device data");
    await expect(sourcePage.getByRole("button", { name: "合并本机数据", exact: true })).toHaveCount(0);
    const laterPage = await laterDevice.newPage();
    await seedGuest(laterPage, "Must never replace the account");
    await laterPage.goto("/");
    await loginFromBiff(laterPage, userEmail);
    await waitSynced(laterPage);
    expect(await laterPage.evaluate(() => JSON.parse(localStorage.getItem("biff.picks.v2")!)[0].note)).toBe("First device data");
    await laterPage.getByRole("button", { name: "退出账号", exact: true }).click();
    await loginFromBiff(laterPage, userEmail);
    await waitSynced(laterPage);
    const again = await (await laterPage.request.get("/api/account/sync/biff-2026")).json();
    expect(again.importedAt).toBe(imported.importedAt);
    expect(again.revision).toBe(imported.revision);
    expect(JSON.parse(again.records[record]).note).toBe("First device data");
  } finally { await sourceDevice.close(); await laterDevice.close(); }
});

test("concurrent imports claim the account once and failed revisions leave it eligible", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip() });
  await registerFromBiff(page, email());
  await waitSynced(page);
  const initialDoc = await (await page.request.get("/api/account/sync/biff-2026")).json();
  const attempt = (name: string, revision: number, operationId = randomUUID()) => page.request.post("/api/account/import", {
    headers: { Origin: origin },
    data: { subject: initialDoc.subject, revision, operationId, records: { [`local:biff.${name}`]: JSON.stringify(name) }, sourceRecords: { [`local:biff.${name}`]: JSON.stringify(name) } },
  });
  expect((await attempt("failed", initialDoc.revision + 3)).status()).toBe(409);
  expect((await (await page.request.get("/api/account/sync/biff-2026")).json()).importedAt).toBeNull();
  const responses = await Promise.all([attempt("first", initialDoc.revision), attempt("second", initialDoc.revision)]);
  for (const response of responses) expect(response.status()).toBe(200);
  const outcomes = await Promise.all(responses.map((response) => response.json()));
  expect(outcomes.filter((outcome) => outcome.imported)).toHaveLength(1);
  const finalDoc = await (await page.request.get("/api/account/sync/biff-2026")).json();
  expect(finalDoc.revision).toBe(initialDoc.revision + 1);
  expect(Object.keys(finalDoc.records)).toHaveLength(1);
  const repeated = await (await attempt("third", finalDoc.revision)).json();
  expect(repeated.imported).toBe(false);
  expect(repeated.records).toEqual(finalDoc.records);
  expect(repeated.importedAt).toBe(finalDoc.importedAt);
});

test("lost import response retries without importing the account twice", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip() });
  let committed = false;
  await page.route("**/api/account/import", async (route) => {
    if (!committed) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed = true;
      await route.abort("failed");
    } else await route.continue();
  });
  await seedGuest(page);
  await page.goto("/");
  await registerFromBiff(page, email());
  await expect.poll(() => committed).toBe(true);
  await expect(page.locator("#account-sync-status")).toHaveText("暂未同步");
  const committedDoc = await (await page.request.get("/api/account/sync/biff-2026")).json();
  expect(committedDoc.importedAt).toEqual(expect.any(Number));
  await page.getByRole("button", { name: "重试同步", exact: true }).click();
  await waitSynced(page);
  const retried = await (await page.request.get("/api/account/sync/biff-2026")).json();
  expect(retried.revision).toBe(committedDoc.revision);
  expect(retried.importedAt).toBe(committedDoc.importedAt);
  expect(JSON.parse(retried.records[record]).note).toBe(initial[0]!.note);
});

test("conflicting first import waits for a choice before marking the account", async ({ page, context, browser }) => {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": ip() });
  const userEmail = email();
  await registerFromBiff(page, userEmail);
  await waitSynced(page);
  const blank = await (await page.request.get("/api/account/sync/biff-2026")).json();
  const cloudRecords = { [record]: JSON.stringify({ key, codes: { [screening.code]: true }, note: "Existing cloud note" }) };
  expect((await page.request.put("/api/account/sync/biff-2026", {
    headers: { Origin: origin },
    data: { subject: blank.subject, revision: blank.revision, operationId: randomUUID(), records: cloudRecords },
  })).status()).toBe(200);
  const sourceDevice = await contextFor(browser, ip());
  try {
    const sourcePage = await sourceDevice.newPage();
    await seedGuest(sourcePage, "Imported note selected by user");
    await sourcePage.goto("/");
    await loginFromBiff(sourcePage, userEmail);
    await expect(sourcePage.getByRole("button", { name: "确认选择并同步", exact: true })).toBeVisible();
    const beforeChoice = await (await sourcePage.request.get("/api/account/sync/biff-2026")).json();
    expect(beforeChoice.importedAt).toBeNull();
    expect(JSON.parse(beforeChoice.records[record]).note).toBe("Existing cloud note");
    await sourcePage.getByRole("dialog", { name: "IFFDAY 账号" }).locator("select").selectOption("remote");
    await sourcePage.getByRole("button", { name: "确认选择并同步", exact: true }).click();
    await waitSynced(sourcePage);
    const afterChoice = await (await sourcePage.request.get("/api/account/sync/biff-2026")).json();
    expect(afterChoice.importedAt).toEqual(expect.any(Number));
    expect(JSON.parse(afterChoice.records[record]).note).toBe("Imported note selected by user");
  } finally { await sourceDevice.close(); }
});
