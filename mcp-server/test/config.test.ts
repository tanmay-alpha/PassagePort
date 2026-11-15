import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ConfigError,
  DEFAULT_API_URL,
  DEFAULT_TIMEOUT_MS,
  SERVER_VERSION,
  loadConfig,
} from "../src/config.js";

test("defaults to the local PassagePort server without a token", () => {
  assert.deepEqual(loadConfig({}), {
    apiUrl: DEFAULT_API_URL,
    apiToken: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    warnings: [],
  });
});

test("normalises the URL and reads token and timeout", () => {
  const config = loadConfig({
    PASSAGEPORT_API_URL: " https://docs.example.com/passageport/ ",
    PASSAGEPORT_API_TOKEN: " pp_secret ",
    PASSAGEPORT_TIMEOUT_MS: "5000",
  });
  assert.equal(config.apiUrl, "https://docs.example.com/passageport");
  assert.equal(config.apiToken, "pp_secret");
  assert.equal(config.timeoutMs, 5000);
  assert.deepEqual(config.warnings, []);
});

test("rejects URLs that are malformed, non-HTTP or carry credentials", () => {
  for (const url of [
    "not a url",
    "ftp://example.com",
    "https://user:pass@example.com",
    "https://example.com/?token=1",
  ]) {
    assert.throws(() => loadConfig({ PASSAGEPORT_API_URL: url }), ConfigError, url);
  }
});

test("configuration errors never echo the offending value", () => {
  assert.throws(
    () => loadConfig({ PASSAGEPORT_API_URL: "https://user:hunter2@example.com" }),
    (error: unknown) => error instanceof ConfigError && !error.message.includes("hunter2"),
  );
});

test("rejects timeouts that are not sane integers", () => {
  for (const value of ["abc", "0", "1.5", "-20", "999999999"]) {
    assert.throws(() => loadConfig({ PASSAGEPORT_TIMEOUT_MS: value }), ConfigError, value);
  }
});

test("warns when a token would travel over plain HTTP to a remote host", () => {
  const remote = loadConfig({
    PASSAGEPORT_API_URL: "http://docs.example.com",
    PASSAGEPORT_API_TOKEN: "pp_secret",
  });
  assert.equal(remote.warnings.length, 1);
  assert.ok(!remote.warnings[0]?.includes("pp_secret"));

  for (const url of ["http://localhost:8000", "http://127.0.0.1:8000", "http://[::1]:8000"]) {
    const local = loadConfig({ PASSAGEPORT_API_URL: url, PASSAGEPORT_API_TOKEN: "pp_secret" });
    assert.deepEqual(local.warnings, [], url);
  }
  // A hostname that happens to be an Object.prototype key is still a remote host.
  const tricky = loadConfig({
    PASSAGEPORT_API_URL: "http://constructor",
    PASSAGEPORT_API_TOKEN: "pp_secret",
  });
  assert.equal(tricky.warnings.length, 1);
});

test("the advertised server version matches package.json", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(SERVER_VERSION, manifest.version);
});
