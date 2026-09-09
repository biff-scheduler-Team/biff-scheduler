// /api/mapping/:code — 豆瓣映射查询 / 写入
// Pages Functions: functions/api/mapping/[code].js
// douban_url 需为 https://movie.douban.com/subject/<id>/ 形式,服务端正则抽 id。

function parseDoubanUrl(url) {
  if (!url) return null;
  const m = String(url).match(/movie\.douban\.com\/subject\/(\d+)/);
  return m ? { subject_id: Number(m[1]), douban_url: `https://movie.douban.com/subject/${m[1]}/` } : null;
}

export async function onRequestGet({ env, params }) {
  const code = String(params.code || "");
  const row = await env.DB.prepare(
    "SELECT code, subject_id, title_cn, douban_url, updated_at FROM douban_map WHERE code = ?"
  )
    .bind(code)
    .first();
  return Response.json({ ok: true, data: row ?? null });
}

export async function onRequestPut({ env, params, request }) {
  const code = String(params.code || "");
  if (!/^\d{3}$/.test(code)) {
    return Response.json({ ok: false, error: "code 需为 3 位数字" }, { status: 400 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "body 需为 JSON" }, { status: 400 });
  }

  const parsed = parseDoubanUrl(body.douban_url ?? body.subject_id ?? "");
  let subject_id = body.subject_id ? Number(body.subject_id) : null;
  let douban_url = body.douban_url ? String(body.douban_url).trim() : null;
  if (parsed) {
    subject_id = parsed.subject_id;
    douban_url = parsed.douban_url;
  }
  const title_cn = body.title_cn ? String(body.title_cn).trim().slice(0, 100) : null;

  if (!subject_id && !title_cn) {
    return Response.json({ ok: false, error: "需要 douban_url 或 subject_id 或 title_cn" }, { status: 400 });
  }

  await env.DB.prepare(
    `INSERT INTO douban_map (code, subject_id, title_cn, douban_url, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (code)
     DO UPDATE SET subject_id = COALESCE(excluded.subject_id, douban_map.subject_id),
                   title_cn   = COALESCE(excluded.title_cn, douban_map.title_cn),
                   douban_url = COALESCE(excluded.douban_url, douban_map.douban_url),
                   updated_at = datetime('now')`
  )
    .bind(code, subject_id, title_cn, douban_url)
    .run();

  return Response.json({ ok: true, data: { code, subject_id, title_cn, douban_url } });
}
