import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          // Tests in this suite build on each other's rows within a file
          // (seed in one `it`, read in the next). Default per-test storage
          // rollback would break that, so isolation is off; singleWorker
          // keeps files sequential and deterministic.
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              SR_TOKEN: "test-token",
              RESEND_API_KEY: "test-key"
            }
          }
        }
      }
    }
  };
});
