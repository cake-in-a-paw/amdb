import { builtinEnvironments, type Environment } from 'vitest/runtime';

/**
 * jsdom globals, but modules go through Vite's `ssr` transform instead of `client`. The client
 * transform rewrites `new URL('…', import.meta.url)` into a dev-server asset URL, which breaks the
 * API's migrations path (`fileURLToPath` then throws "The URL must be of scheme file"), so the
 * in-process API can't open its database. See ADR 0004.
 */
export default { ...builtinEnvironments.jsdom, name: 'jsdom-ssr', viteEnvironment: 'ssr' } satisfies Environment;
