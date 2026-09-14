// 官网口径一致性 —— `festival-extras.json` / `films.json` 两个产物必须与 BIFF 官网对齐。
//
// 为什么单测它:这类错**不报类型错、不报运行错** —— 表现只是弹层里多了一条去年的节目、
// 影院说明里写着「本届没有南浦洞」、或把官方说明页当成购票入口写进 .ics,
// 不逐条对官网根本发现不了。数据是判定基准;涉及「用户实际看到的字」时读源码文本断言。
//
// 2026-09-14(`PLAN-20260914143817`):首版,钉住 4 处已订正的错误口径 + 新增的票务字段。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

interface Program {
  code: string;
  dateText: string;
}

const extras = JSON.parse(read("public/festival-extras.json")) as {
  ticketing: {
    batches: { includes: string; openText: string }[];
    discounts?: { who: string; terms: string[] }[];
    refund?: {
      deadline: string;
      fees: { when: string; fee: string; note: string }[];
      howTo: string[];
      notes: string[];
    };
    salesPeriod?: { period: string; hours: string; payment: string };
    serviceDesk?: { location: string };
    email?: string;
    bookingUrl?: string;
    url: string;
  };
  programs: Program[];
};
const films = JSON.parse(read("public/films.json")) as {
  films: { title_en: string; unit: string }[];
};
const screenings = (
  JSON.parse(read("public/schedule.json")) as { screenings: { date: string }[] }
).screenings;

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** `dateText` 里的「月 日」→ `[月, 日]`;解析不出返回 null(与脚本同口径:宁可判不合格)。 */
function monthDay(text: string): [number, number] | null {
  const m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\b/i.exec(text);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  return mon ? [mon, Number(m[2])] : null;
}

/** 展期从排期推导(不硬编码年份)—— 与 `tools/scrape_biff_extras.py::month_day_in_range` 同口径。 */
const festDays = [...new Set(screenings.map((s) => s.date))].sort();
const firstMd: [number, number] = [Number(festDays[0].slice(5, 7)), Number(festDays[0].slice(8, 10))];
const lastMd: [number, number] = [
  Number(festDays[festDays.length - 1].slice(5, 7)),
  Number(festDays[festDays.length - 1].slice(8, 10)),
];

describe("festival-extras 与官网口径对齐", () => {
  it("programs 里每个节目的日期都落在本届展期内", () => {
    const outside = extras.programs.filter((p) => {
      const md = monthDay(p.dateText);
      if (!md) return true;
      if (md[0] !== firstMd[0] && md[0] !== lastMd[0]) return md[0] < firstMd[0] || md[0] > lastMd[0];
      if (md[0] === firstMd[0]) return md[1] < firstMd[1];
      return md[1] > lastMd[1];
    });
    expect(outside.map((p) => `${p.code} ${p.dateText}`)).toEqual([]);
  });

  it("2025 的 Carte Blanche 遗留条目不在这份数据里（编号被本届复用过 338 / 408）", () => {
    const codes = extras.programs.map((p) => p.code);
    expect(codes).not.toContain("338");
    expect(codes).not.toContain("408");
  });

  it("开票批次只有官网票务页印的两批（newsletter 口径的 9/11 不算）", () => {
    expect(extras.ticketing.batches.map((b) => b.openText)).toEqual([
      "Sep 17(Thu) 14:00 (KST)",
      "Sep 21(Mon) 14:00 (KST)",
    ]);
    expect(JSON.stringify(extras.ticketing.batches)).not.toContain("Sep 11");
  });

  it("购票入口是 ticket.biff.kr，不是官方说明页（.ics 里写错会让用户找不到下单按钮）", () => {
    expect(extras.ticketing.bookingUrl).toBe("https://ticket.biff.kr/");
    expect(extras.ticketing.url).not.toBe(extras.ticketing.bookingUrl);
  });

  it("票务补充字段齐全（售票期 / 退款三档 / 折扣三组 / 客服邮箱 / 服务台）", () => {
    expect(extras.ticketing.salesPeriod?.period).toBe("9.17 ~ 10.15");
    expect(extras.ticketing.refund?.fees).toHaveLength(3);
    expect(extras.ticketing.discounts).toHaveLength(3);
    expect(extras.ticketing.serviceDesk?.location).toBeTruthy();
    expect(extras.ticketing.email).toBe("cs@biff.kr");
  });

  it("折扣年龄口径 = 1961 年及以前出生（官网票务页；newsletter 的 1960 不采）", () => {
    const src = read("src/components/InfoDialogs.tsx");
    expect(src).toContain("1961 年及以前出生");
    expect(src).not.toContain("1961 年前出生");
  });
});

describe("films.json 单元归属与官网 prog_view 一致", () => {
  it("Open Cinema = 5 部，含 The Violinist、不含大圣崛起", () => {
    const names = films.films.filter((f) => f.unit === "Open Cinema").map((f) => f.title_en);
    expect(names).toHaveLength(5);
    expect(names).toContain("The Violinist");
    expect(names).not.toContain("Spirit Guardians: The Last Secret Of The First Emperor");
  });

  it("亚洲电影之窗 = 27 部，含大圣崛起、不含 The Violinist", () => {
    const names = films.films.filter((f) => f.unit === "亚洲电影之窗").map((f) => f.title_en);
    expect(names).toHaveLength(27);
    expect(names).toContain("Spirit Guardians: The Last Secret Of The First Emperor");
    expect(names).not.toContain("The Violinist");
  });
});

describe("影院说明不再断言「本届没有南浦洞」", () => {
  const src = read("src/components/InfoDialogs.tsx");

  it("不出现「本届未参与」这种把「本工具没收录」说成「本届没有」的断言", () => {
    expect(src).not.toContain("本届未参与");
  });

  it("说明了 Community BIFF 在南浦洞另有会场（MEGABOX Busan Theater）", () => {
    expect(src).toContain("Community BIFF");
    expect(src).toContain("MEGABOX Busan Theater");
  });
});
