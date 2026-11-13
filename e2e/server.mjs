// Starts and stops the real PassagePort backend for the end-to-end suite.
//
// The backend serves the built frontend (frontend/dist) and stores everything in a data directory
// that survives restarts, so tests can stop the process, start it again and check persistence.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, "../backend");
const staticDir = resolve(here, "../frontend/dist");

export const PORT = Number(process.env.E2E_PORT ?? 8765);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** A fresh data directory per test run unless E2E_DATA_DIR pins one. */
export function createDataDir() {
  return process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "passageport-e2e-"));
}

export class BackendServer {
  constructor(dataDir, extraEnv = {}) {
    this.dataDir = dataDir;
    this.extraEnv = extraEnv;
    this.child = null;
    this.log = "";
  }

  async start() {
    if (!existsSync(join(staticDir, "index.html"))) {
      throw new Error(`frontend build not found at ${staticDir}; run "npm run build" in frontend/ first`);
    }
    this.child = spawn(
      "uv",
      ["run", "--no-sync", "uvicorn", "passageport.main:app", "--host", "127.0.0.1", "--port", String(PORT)],
      {
        cwd: backendDir,
        env: {
          ...process.env,
          PP_DATA_DIR: this.dataDir,
          PP_STATIC_DIR: staticDir,
          PP_EMBEDDING_BACKEND: "hashing",
          PP_RERANKER_BACKEND: "none",
          PP_AUTH_MODE: "local",
          PP_LOG_LEVEL: "WARNING",
          ...this.extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );
    const collect = (chunk) => {
      this.log = (this.log + chunk.toString()).slice(-20_000);
    };
    this.child.stdout.on("data", collect);
    this.child.stderr.on("data", collect);
    await this.waitUntilHealthy();
  }

  async waitUntilHealthy(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(`backend exited with code ${this.child.exitCode}\n${this.log}`);
      }
      try {
        const res = await fetch(`${BASE_URL}/api/health`);
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`backend did not become healthy in ${timeoutMs} ms\n${this.log}`);
  }

  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    if (process.platform === "win32") {
      // `shell: true` wraps the server in cmd.exe; kill the whole tree.
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    } else {
      child.kill("SIGTERM");
    }
    await exited;
    this.child = null;
  }
}
