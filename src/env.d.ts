export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SR_TOKEN: string;
  /** Optional; prefer Settings. Kept so existing Worker secrets / .dev.vars still work. */
  RESEND_API_KEY?: string;
  /** Optional; prefer auto-detected / Settings `base_url`. */
  BASE_URL?: string;
  /** Optional; prefer Settings. */
  EMAIL_TO?: string;
  EMAIL_FROM: string;
}
