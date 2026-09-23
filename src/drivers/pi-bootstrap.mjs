import { register } from 'tsx/esm/api';

// The candidate cwd may contain tsconfig/baseUrl/paths settings; never let them
// alter imports for this trusted worker bootstrap.
register({ tsconfig: false });
await import(new URL('./pi-worker.ts', import.meta.url).href);
