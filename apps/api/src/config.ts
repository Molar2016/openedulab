import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export type AppEnv = 'development' | 'test' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppConfig {
  readonly env: AppEnv;
  readonly host: string;
  readonly port: number;
  readonly publicOrigin: string;
  readonly databasePath: string;
  readonly migrationsDir: string;
  readonly staticDir: string;
  readonly logLevel: LogLevel;
}

export interface ConfigIssue {
  readonly field: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      [
        'Refusing to start: invalid server configuration.',
        ...issues.map((issue) => `  - ${issue.field}: ${issue.message}`),
        'See .env.example for the required variables.',
      ].join('\n'),
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const REQUIRED_KEYS = [
  'OEL_ENV',
  'OEL_PORT',
  'OEL_PUBLIC_ORIGIN',
  'OEL_DATABASE_PATH',
  'OEL_STATIC_DIR',
  'OEL_MIGRATIONS_DIR',
] as const;

const OPTIONAL_KEYS = ['OEL_HOST', 'OEL_LOG_LEVEL'] as const;

const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

const APP_ENVS: readonly AppEnv[] = ['development', 'test', 'production'];
const LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_LOG_LEVEL: LogLevel = 'info';

function read(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isDirectory(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Parses and validates the whole environment, collecting every problem instead of
 * failing on the first one. Throws ConfigError when anything is missing or invalid;
 * there is no silent fallback for required settings.
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const issues: ConfigIssue[] = [];

  for (const key of Object.keys(env)) {
    if (key.startsWith('OEL_') && !KNOWN_KEYS.has(key)) {
      issues.push({
        field: key,
        message: 'unknown setting; check for a typo or remove it',
      });
    }
  }

  const missing = REQUIRED_KEYS.filter((key) => read(env, key) === undefined);
  for (const key of missing) {
    issues.push({ field: key, message: 'is required and has no default' });
  }

  const envValue = read(env, 'OEL_ENV');
  let appEnv: AppEnv = 'production';
  if (envValue !== undefined) {
    if (!APP_ENVS.includes(envValue as AppEnv)) {
      issues.push({ field: 'OEL_ENV', message: `must be one of ${APP_ENVS.join(', ')}` });
    } else {
      appEnv = envValue as AppEnv;
    }
  }

  const portValue = read(env, 'OEL_PORT');
  let port = 0;
  if (portValue !== undefined) {
    if (!/^\d+$/.test(portValue)) {
      issues.push({ field: 'OEL_PORT', message: 'must be an integer between 1 and 65535' });
    } else {
      port = Number(portValue);
      if (port < 1 || port > 65535) {
        issues.push({ field: 'OEL_PORT', message: 'must be between 1 and 65535' });
      }
    }
  }

  const host = read(env, 'OEL_HOST') ?? DEFAULT_HOST;

  const logLevelValue = read(env, 'OEL_LOG_LEVEL');
  let logLevel: LogLevel = DEFAULT_LOG_LEVEL;
  if (logLevelValue !== undefined) {
    if (!LOG_LEVELS.includes(logLevelValue as LogLevel)) {
      issues.push({ field: 'OEL_LOG_LEVEL', message: `must be one of ${LOG_LEVELS.join(', ')}` });
    } else {
      logLevel = logLevelValue as LogLevel;
    }
  }

  const originValue = read(env, 'OEL_PUBLIC_ORIGIN');
  let publicOrigin = '';
  if (originValue !== undefined) {
    const parsed = parseOrigin(originValue);
    if (typeof parsed === 'string') {
      issues.push({ field: 'OEL_PUBLIC_ORIGIN', message: parsed });
    } else {
      publicOrigin = parsed.origin;
    }
  }

  const databaseValue = read(env, 'OEL_DATABASE_PATH');
  let databasePath = '';
  if (databaseValue !== undefined) {
    if (databaseValue === ':memory:') {
      if (appEnv === 'production') {
        issues.push({
          field: 'OEL_DATABASE_PATH',
          message: 'must be a file path in production; :memory: loses all data on restart',
        });
      } else {
        databasePath = databaseValue;
      }
    } else {
      databasePath = resolve(databaseValue);
    }
  }

  const staticValue = read(env, 'OEL_STATIC_DIR');
  let staticDir = '';
  if (staticValue !== undefined) {
    staticDir = resolve(staticValue);
    if (!isDirectory(staticDir)) {
      issues.push({ field: 'OEL_STATIC_DIR', message: `directory does not exist: ${staticDir}` });
      staticDir = '';
    } else if (!isFile(resolve(staticDir, 'index.html'))) {
      issues.push({
        field: 'OEL_STATIC_DIR',
        message: `directory has no index.html (run "npm run build" first): ${staticDir}`,
      });
      staticDir = '';
    }
  }

  const migrationsValue = read(env, 'OEL_MIGRATIONS_DIR');
  let migrationsDir = '';
  if (migrationsValue !== undefined) {
    migrationsDir = resolve(migrationsValue);
    if (!isDirectory(migrationsDir)) {
      issues.push({
        field: 'OEL_MIGRATIONS_DIR',
        message: `directory does not exist: ${migrationsDir}`,
      });
      migrationsDir = '';
    } else if (!hasMigrationFile(migrationsDir)) {
      issues.push({
        field: 'OEL_MIGRATIONS_DIR',
        message: `directory contains no NNNN_name.sql migration: ${migrationsDir}`,
      });
      migrationsDir = '';
    }
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return Object.freeze({
    env: appEnv,
    host,
    port,
    publicOrigin,
    databasePath,
    migrationsDir,
    staticDir,
    logLevel,
  });
}

/** Returns a normalized origin, or a human-readable reason why the value is rejected. */
function parseOrigin(value: string): { origin: string } | string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an absolute http(s) origin such as http://127.0.0.1:3210';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'must use http or https';
  }
  if (url.username !== '' || url.password !== '') {
    return 'must not embed credentials';
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return 'must be an origin only (no path, query or fragment)';
  }
  return { origin: url.origin };
}

function hasMigrationFile(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => MIGRATION_FILE.test(entry));
  } catch {
    return false;
  }
}

export function describeConfigForLog(config: AppConfig): Record<string, string | number> {
  return {
    env: config.env,
    host: config.host,
    port: config.port,
    publicOrigin: config.publicOrigin,
    databasePath: config.databasePath,
    migrationsDir: config.migrationsDir,
    staticDir: config.staticDir,
  };
}
