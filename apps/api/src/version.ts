import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

const MAX_DEPTH = 10;

/**
 * Reads the version from the repository's package.json so the health endpoint reports
 * what is actually running rather than a hard-coded string. Walks up from the calling
 * module, which works for both `src/` and compiled `dist/`.
 */
export function readAppVersion(startDir: string): string {
  let dir = startDir;

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        parsed.name === 'openedulab' &&
        typeof parsed.version === 'string' &&
        parsed.version.length > 0
      ) {
        return parsed.version;
      }
    } catch {
      // No readable package.json here; keep walking towards the filesystem root.
    }

    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) {
      break;
    }
    dir = parent;
  }

  throw new Error(`Cannot find the openedulab package.json above ${startDir} to read appVersion`);
}
