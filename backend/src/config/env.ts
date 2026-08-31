import { z } from "zod"
import dotenv from "dotenv"
import { jsessionIdFrom } from "../linkedin/cookies"
dotenv.config()

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    // 4000, not 3000: `next dev` in ../frontend claims 3000, and two processes
    // fighting over one port is a confusing first five minutes for anybody
    // running both halves of this repo at once.
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    API_KEY: z.string().min(1, "API_KEY is required"),

    /**
     * Comma-separated browser origins allowed to call this API, or `*` for any.
     * Defaults to `*`: the frontend is a browser app on a different origin, and a
     * restrictive default would make its very first request fail for a reason
     * that shows up only in the browser console. CORS is not the access control
     * here — `Authorization: Bearer` is, and a bearer header is never sent
     * automatically by a browser the way a cookie is — so a permissive default
     * costs nothing an attacker could not already do with curl.
     */
    CORS_ORIGINS: z.string().default("*"),

    /**
     * A complete raw `cookie:` header copied from a real logged-in request
     * (`npm run import:cookie` prints it). Preferred over the two-cookie pair
     * below: sending only `li_at` + `JSESSIONID` is what got a session actively
     * revoked — see docs/notes.md. Used verbatim when set.
     */
    LINKEDIN_COOKIE: z.string().default(""),
    /** Fallback, kept so existing setups keep working. */
    LINKEDIN_LI_AT: z.string().default(""),
    LINKEDIN_JSESSIONID: z.string().default(""),

    /**
     * The restli decoration that makes one profile fetch return everything.
     *
     * Its version suffix rotates on LinkedIn's schedule, exactly like a GraphQL
     * `queryId` hash, so it is configuration rather than a constant in the
     * client. The default is the value observed returning HTTP 200; if
     * extraction starts failing with a 4xx that is not about the session, this
     * is the first thing to bump.
     */
    LINKEDIN_PROFILE_DECORATION_ID: z
      .string()
      .min(1)
      .default("com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93"),

    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(3600),
    UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  })
  /**
   * One of the two credential forms has to be present, and a captured header has
   * to carry the cookies we actually derive things from. Checked here so a
   * misconfigured deployment stops at boot rather than 503-ing every request.
   * Messages name variables only — never their values.
   */
  .superRefine((cfg, ctx) => {
    const raw = cfg.LINKEDIN_COOKIE.trim()
    if (!raw) {
      if (!cfg.LINKEDIN_LI_AT.trim() || !cfg.LINKEDIN_JSESSIONID.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["LINKEDIN_COOKIE"],
          message:
            "Upstream credentials are missing: set LINKEDIN_COOKIE to a full captured cookie header (see `npm run import:cookie`), or set both LINKEDIN_LI_AT and LINKEDIN_JSESSIONID.",
        })
      }
      return
    }
    if (!jsessionIdFrom(raw)) {
      ctx.addIssue({
        code: "custom",
        path: ["LINKEDIN_COOKIE"],
        message:
          "LINKEDIN_COOKIE has no JSESSIONID cookie; the csrf-token header is derived from it and every request would 403. Re-copy the whole cookie header.",
      })
    }
    if (!/(?:^|;)\s*li_at=[^;\s]/i.test(raw)) {
      ctx.addIssue({
        code: "custom",
        path: ["LINKEDIN_COOKIE"],
        message:
          "LINKEDIN_COOKIE has no li_at cookie, so it is not an authenticated session. Copy the header from a request made while logged in.",
      })
    }
  })

export const env = envSchema.parse(process.env)
