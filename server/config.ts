import { z } from "zod";
const schema = z.object({
  APP_ENV: z.enum(["local", "production"]),
  APP_ORIGIN: z.url(),
  IFFDAY_ORIGIN: z.url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(32),
  SESSION_SECRET: z.string().min(32),
});
export function configuration(env: Env) {
  const config = schema.parse(env);
  for (const origin of [config.APP_ORIGIN, config.IFFDAY_ORIGIN]) {
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
  return config;
}
export type Configuration = ReturnType<typeof configuration>;
