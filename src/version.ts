// The tool's version, as shown by --version and written into report.json.
import { createRequire } from 'node:module';

// package.json is the single source of the version (src/ and dist/ both sit one level below it).
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
export const VERSION = pkg.version;
