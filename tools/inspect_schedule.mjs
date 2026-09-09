import fs from "node:fs";
const sc = JSON.parse(fs.readFileSync("public/schedule.json", "utf8")).screenings;
const m = (t) => parseInt(t.slice(0, 2)) * 60 + parseInt(t.slice(3, 5));
console.log("total", sc.length);
const starts = sc.map((x) => m(x.start_time)).sort((a, b) => a - b);
console.log("start min range:", starts[0], "-", starts[starts.length - 1]);
for (const x of sc) {
  const st = m(x.start_time), en = m(x.end_time);
  if (st < 9 * 60 || en > 24 * 60 || st >= 22 * 60)
    console.log("LATE/EARLY:", x.code, x.date, x.start_time, x.end_time, x.venue_id);
}
console.log("dates:", [...new Set(sc.map((x) => x.date))].sort().join(" "));
