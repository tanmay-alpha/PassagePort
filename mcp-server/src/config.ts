/**
 * Runtime configuration, read from environment variables set by the MCP client.
 */

export const SERVER_NAME = "PassagePort";
export const SERVER_VERSION = "1.0.0";

export const DEFAULT_API_URL = "http://127.0.0.1:8000";
/** Longer than the backend's own LLM timeout (60 s) so its error message arrives before ours. */
export const DEFAULT_TIMEOUT_MS = 90_000;

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

export interface Config {
  /** Origin of the PassagePort server, without a trailing slash. */
  apiUrl: string;
  /** Bearer API token; required when the server runs with PP_AUTH_MODE=accounts. */
  apiToken?: string;
  timeoutMs: number;
  /** Non-fatal configuration problems, printed to stderr at startup. */
  warnings: string[];
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const rawUrl = env.PASSAGEPORT_API_URL?.trim() || DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError("PASSAGEPORT_API_URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("PASSAGEPORT_API_URL must start with http:// or https://.");
  }
  if (url.username || url.password) {
    // Credentials in the URL would end up in logs and error messages.
    throw new ConfigError(
      "PASSAGEPORT_API_URL must not contain credentials; use PASSAGEPORT_API_TOKEN instead.",
    );
  }
  if (url.search || url.hash) {
    throw new ConfigError("PASSAGEPORT_API_URL must not contain a query string or fragment.");
  }

  const apiToken = env.PASSAGEPORT_API_TOKEN?.trim() || undefined;

  const rawTimeout = env.PASSAGEPORT_TIMEOUT_MS?.trim();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout) {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
      throw new ConfigError("PASSAGEPORT_TIMEOUT_MS must be an integer between 100 and 600000.");
    }
  }

  const warnings: string[] = [];
  if (apiToken && url.protocol === "http:" && !Object.hasOwn(LOOPBACK_HOSTS, url.hostname)) {
    warnings.push(
      "PASSAGEPORT_API_TOKEN is being sent over plain HTTP to a non-loopback host; use https://.",
    );
  }

  const path = url.pathname.replace(/\/+$/, "");
  return { apiUrl: `${url.origin}${path}`, apiToken, timeoutMs, warnings };
}
