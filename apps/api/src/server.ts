import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { readAppVersion } from './version.js';

export interface RunningServer {
  readonly url: string;
  readonly config: AppConfig;
  readonly version: string;
  readonly app: FastifyInstance;
  close(): Promise<void>;
}

export interface StartServerOptions {
  /** Override for tests; defaults to the repository package.json version. */
  readonly version?: string;
}

/**
 * Validates configuration, applies migrations and binds the socket. Any failure
 * propagates: the caller decides the exit code, and nothing listens on error.
 */
export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const config = loadConfig(env);
  const version =
    options.version ?? readAppVersion(dirname(fileURLToPath(import.meta.url)));
  const app = await buildApp({ config, version });

  try {
    const url = await app.listen({ host: config.host, port: config.port });
    return {
      url,
      config,
      version,
      app,
      close: async () => {
        await app.close();
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}
