export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SR_TOKEN: string;
  RESEND_API_KEY: string;
  BASE_URL: string;
  EMAIL_TO: string;
  EMAIL_FROM: string;
}
