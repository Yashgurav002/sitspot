import { defineConfig, devices } from "@playwright/test";

// Smoke test against the production build; the API is mocked with page.route().
export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://localhost:3100", ...devices["Pixel 7"] },
  webServer: { command: "pnpm exec next start -p 3100", url: "http://localhost:3100/login", reuseExistingServer: true },
});
