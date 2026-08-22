import type { Env } from "../src/env.d";

// Test-side typing for the `cloudflare:workers` module: the bindings the tests see
// (wrangler.jsonc plus the extra ones vitest.config.ts injects).
declare global {
  namespace Cloudflare {
    interface Env extends EnvBindings {}
  }
}
interface EnvBindings extends Env {
  TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
}
export {};
