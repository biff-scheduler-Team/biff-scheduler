import { z } from "zod";
const schema = z.object({
  APP_ENV: z.enum(["local", "production"]),
  APP_ORIGIN: z.string(),
  IFFDAY_ORIGIN: z.url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(32),
  SESSION_SECRET: z.string().min(32),
});
export function configuration(env: Env) {
  const config = schema.parse(env);
  // APP_ORIGIN 接受逗号分隔的多个来源：新域名可以先并行上线，
  // 等旧域名退役再删。第一项是默认来源 ——
  // 请求自己没有可用 host 时就用它。
  const origins = config.APP_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean);
  if (!origins.length) throw new Error("Missing configured origin");
  for (const origin of [...origins, config.IFFDAY_ORIGIN]) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password)
      throw new Error("Invalid configured origin");
    if (
      config.APP_ENV === "production"
        ? url.protocol !== "https:"
        : !["127.0.0.1", "localhost"].includes(url.hostname)
    )
      throw new Error("Invalid origin environment");
  }
  return { ...config, origins };
}
export type Configuration = ReturnType<typeof configuration>;
