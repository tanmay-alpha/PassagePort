export const PORT: number;
export const BASE_URL: string;
export function createDataDir(): string;
export class BackendServer {
  constructor(dataDir: string, extraEnv?: Record<string, string>);
  readonly dataDir: string;
  log: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  waitUntilHealthy(timeoutMs?: number): Promise<void>;
}
