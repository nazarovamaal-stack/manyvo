import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["apps/web/**/*.test.tsx"],
    environmentOptions: { jsdom: { url: "http://localhost:3000" } },
  },
});
