// 备份 / 迁移的纯逻辑单测。
//
// 为什么单测它:换域名搬家时「丢数据」是不可接受的失败,而这里的判定全是纯函数 ——
// 前缀筛选(哪些键要搬)、整体替换(旧键清没清干净)、宽容解析(用户给的内容认不认),
// 三件事都不会抛错、不会报类型错,只能靠断言守住。
// 用内存替身而非 jsdom:被测模块在 import 期不碰 DOM / localStorage(真机入口才读)。

import { describe, expect, it } from "vitest";
import { BACKUP_PREFIX, parseBackupText, parseIcsCodes, restore, snapshot, type BackupStorage } from "../src/backup";

/** 最小内存 Storage 替身(顺序稳定,便于断言) */
function memStorage(init: Record<string, string> = {}): BackupStorage {
  const m = new Map<string, string>(Object.entries(init));
  return {
    get length(): number {
      return m.size;
    },
    key: (i: number): string | null => [...m.keys()][i] ?? null,
    getItem: (k: string): string | null => m.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      m.set(k, v);
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
  };
}

describe("parseIcsCodes:从 .ics 反解场次", () => {
  /** 一份最小的导出 .ics(两条场次) */
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:375@biff-2026",
    "SUMMARY:x",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:419@biff-2026",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("反解出场次 code(保序)", () => {
    const r = parseIcsCodes(ics);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.codes).toEqual(["375", "419"]);
  });

  it("重复 UID 只取一次", () => {
    const t = ["BEGIN:VCALENDAR", "UID:375@biff-2026", "UID:375@biff-2026", "END:VCALENDAR"].join("\n");
    const r = parseIcsCodes(t);
    if (r.ok) expect(r.codes).toEqual(["375"]);
  });

  it("开票日历的 UID(biff-ticket-N)不算场次", () => {
    const t = ["BEGIN:VCALENDAR", "UID:biff-ticket-1@biff-2026", "UID:375@biff-2026", "END:VCALENDAR"].join("\n");
    const r = parseIcsCodes(t);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.codes).toEqual(["375"]);
  });

  it("不是 .ics → 报错", () => {
    expect(parseIcsCodes('{"biff.picks.v2":"[]"}').ok).toBe(false);
  });

  it("是 .ics 但没有本工具的 UID → 报错", () => {
    const t = ["BEGIN:VCALENDAR", "UID:other@example.com", "END:VCALENDAR"].join("\n");
    const r = parseIcsCodes(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("没有本工具导出的场次");
  });

  it("空内容 → 报错", () => {
    expect(parseIcsCodes("   ").ok).toBe(false);
  });
});

describe("snapshot:只搬 biff.* 前缀的键", () => {
  it("按前缀筛掉无关键,值原样搬运(不解析业务结构)", () => {
    const s = memStorage({
      "biff.picks.v2": '[{"key":"cat:f001"}]',
      "biff.settings.v1": '{"alarmMin":45}',
      "unrelated.key": "x",
      "biff-plan-without-dot": "y",
    });
    const file = snapshot(s, new Date("2026-09-11T00:00:00.000Z"), "https://old.example.com");
    expect(Object.keys(file.data).sort()).toEqual(["biff.picks.v2", "biff.settings.v1"]);
    expect(file.data["biff.picks.v2"]).toBe('[{"key":"cat:f001"}]');
    expect(file.app).toBe("biff-scheduler");
    expect(file.origin).toBe("https://old.example.com");
  });

  it("本机无数据 → 空 data(调用方据此不产出空文件)", () => {
    expect(Object.keys(snapshot(memStorage(), new Date(), "").data)).toHaveLength(0);
  });
});

describe("restore:整体替换,不留旧数据", () => {
  it("先清掉本机全部 biff.* 键,再写入备份内容", () => {
    const s = memStorage({
      "biff.picks.v2": "old",
      "biff.ranks.v1": '{"001":1}',
      "unrelated.key": "keep-me",
    });
    const n = restore(s, { "biff.picks.v2": "new", "biff.gvtalk.v1": '{"001":true}' });
    expect(n).toBe(2);
    expect(s.getItem("biff.picks.v2")).toBe("new");
    expect(s.getItem("biff.gvtalk.v1")).toBe('{"001":true}');
    // 本机独有的 biff.* 键被清掉(整体替换,不做合并)
    expect(s.getItem("biff.ranks.v1")).toBeNull();
    // 非 biff.* 键不归备份管,原样保留
    expect(s.getItem("unrelated.key")).toBe("keep-me");
  });

  it("删除时不会因索引前移而漏键(收集后再删)", () => {
    const s = memStorage({
      "biff.a": "1",
      "biff.b": "2",
      "biff.c": "3",
      "biff.d": "4",
    });
    restore(s, { "biff.a": "9" });
    expect(s.length).toBe(1);
    expect(s.getItem("biff.a")).toBe("9");
  });

  it("拒绝非 biff.* 键与非字符串值(备份文件可被手改)", () => {
    const s = memStorage();
    const n = restore(s, {
      "evil.key": "x",
      "biff.ok": "1",
      // 手改备份塞进来的非字符串值 —— 必须挡掉,否则 localStorage 会存进 "[object Object]"
      "biff.bad": undefined as unknown as string,
    });
    expect(n).toBe(1);
    expect(s.getItem("evil.key")).toBeNull();
    expect(s.getItem("biff.bad")).toBeNull();
  });
});

describe("parseBackupText:信封 / 裸表都认,坏输入给得出原因", () => {
  it("认本工具导出的信封格式", () => {
    const r = parseBackupText(
      JSON.stringify({ app: "biff-scheduler", version: 1, data: { "biff.picks.v2": "[]" } })
    );
    expect(r).toEqual({ ok: true, data: { "biff.picks.v2": "[]" } });
  });

  it("也认裸键值表(只复制了 data 段 / 手抄)", () => {
    const r = parseBackupText(JSON.stringify({ "biff.picks.v2": "[]" }));
    expect(r).toEqual({ ok: true, data: { "biff.picks.v2": "[]" } });
  });

  it("非法 JSON / 空内容 / 非对象 / 无 biff 键 → 逐条给出可照做的原因", () => {
    const bad = parseBackupText("not json");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("JSON");

    expect(parseBackupText("   ").ok).toBe(false);
    expect(parseBackupText("[1,2,3]").ok).toBe(false);

    const none = parseBackupText(JSON.stringify({ hello: "world" }));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain(BACKUP_PREFIX);
  });
});

describe("往返:导出 → 序列化 → 解析 → 导入,数据逐字节一致", () => {
  it("端到端不丢不改", () => {
    const src = memStorage({
      "biff.picks.v2": '[{"key":"cat:f001","picks":[{"code":"001"}],"note":"首映"}]',
      "biff.ranks.v1": '{"001":1,"002":2}',
      "biff.settings.v1": '{"alarmMin":45,"transitMin":10,"theme":"dark"}',
    });
    const text = JSON.stringify(snapshot(src, new Date(), "https://old.example.com"), null, 2);

    const parsed = parseBackupText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const dst = memStorage();
    expect(restore(dst, parsed.data)).toBe(3);
    expect(dst.getItem("biff.picks.v2")).toBe(src.getItem("biff.picks.v2"));
    expect(dst.getItem("biff.ranks.v1")).toBe(src.getItem("biff.ranks.v1"));
    expect(dst.getItem("biff.settings.v1")).toBe(src.getItem("biff.settings.v1"));
  });
});
