#!/usr/bin/env node
/**
 * Remove build output and tool caches. Portable replacement for `find ... -exec rm -rf`.
 *
 * Deliberately never touches data (databases, uploads, downloaded models, committed evaluation
 * datasets and results), `.env` files, virtualenvs or node_modules. The evaluation download
 * cache (`eval/.cache`) is removed; the harness fetches it again when needed.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Directories that are always generated, wherever they appear. */
const CACHE_DIRS = { __pycache__: true, ".pytest_cache": true, ".ruff_cache": true, ".mypy_cache": true, ".hypothesis": true };
/** Never descended into: large, or not ours to clean. */
const SKIP_DIRS = { ".git": true, node_modules: true, data: true, models: true };

const FIXED_PATHS = [
  "frontend/dist",
  "frontend/coverage",
  "mcp-server/dist",
  "e2e/playwright-report",
  "e2e/test-results",
  "backend/htmlcov",
  "backend/coverage.xml",
  "backend/.coverage",
  "eval/.cache",
];

let removed = 0;

function remove(target) {
  rmSync(target, { recursive: true, force: true });
  console.log(`removed ${path.relative(root, target)}`);
  removed += 1;
}

function sweep(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `.venv*` also covers backend/.venv-heavy (the PyTorch baseline environment).
    if (!entry.isDirectory() || Object.hasOwn(SKIP_DIRS, entry.name) || entry.name.startsWith(".venv")) continue;
    const full = path.join(dir, entry.name);
    if (Object.hasOwn(CACHE_DIRS, entry.name)) remove(full);
    else sweep(full);
  }
}

for (const relative of FIXED_PATHS) {
  const target = path.join(root, relative);
  if (existsSync(target)) remove(target);
}
sweep(root);
console.log(removed === 0 ? "nothing to clean" : `done (${removed} removed)`);
