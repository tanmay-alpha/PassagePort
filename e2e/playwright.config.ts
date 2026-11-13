import { defineConfig, devices } from "@playwright/test";

/**
 * The suite drives a real backend that serves the built frontend (see server.mjs). The server uses
 * the deterministic hashing embedder so runs need no model download; everything else — upload,
 * parsing, indexing jobs, SQLite persistence, retrieval, citations — is the production code path.
 */
const PORT = Number(process.env.E2E_PORT ?? 8765);

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // tests share one server and restart it
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, testMatch: /core-flow\.spec\.ts/ },
  ],
});
