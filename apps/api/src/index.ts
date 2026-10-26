import { ConfigError, describeConfigForLog } from './config.js';
import { startServer } from './server.js';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

async function run(): Promise<void> {
  const running = await startServer(process.env);

  process.stdout.write(`[openedulab-api] listening on ${running.url}\n`);
  process.stdout.write(
    `[openedulab-api] version ${running.version} config ${JSON.stringify(
      describeConfigForLog(running.config),
    )}\n`,
  );

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    process.stdout.write(`[openedulab-api] ${signal} received, closing\n`);
    try {
      await running.close();
    } catch (error) {
      process.stderr.write(
        `[openedulab-api] shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  };

  for (const signal of SIGNALS) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
}

try {
  await run();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(
      `[openedulab-api] failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.exitCode = 1;
}
