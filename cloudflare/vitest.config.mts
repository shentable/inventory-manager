import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./cloudflare/wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./cloudflare/migrations"),
          TOKEN_SECRET: "worker-test-secret-with-at-least-thirty-two-characters",
          BOOTSTRAP_ADMIN_PIN: "246810",
        },
      },
    })),
  ],
  test: {
    include: ["cloudflare/test/**/*.test.ts"],
  },
});
