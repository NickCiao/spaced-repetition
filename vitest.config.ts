import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SR_TOKEN: "test-token",
            // Mail config must come from D1 settings in tests, never from the
            // developer's local .dev.vars secrets.
            EMAIL_TO: "",
            RESEND_API_KEY: "",
            BASE_URL: ""
          }
        }
      })
    ],
    test: {
      // Storage is isolated per test file (the plugin's v1 model); within a file, tests
      // run in order and build on each other's rows. The setup file applies migrations.
      setupFiles: ["./test/apply-migrations.ts"]
    }
  };
});
