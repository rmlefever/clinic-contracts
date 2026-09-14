import { app } from './app.js';
import { config } from './config.js';

// Process entry point: the application (routes, migrations) lives in src/app.ts.
await app.listen({ port: config.port, host: '0.0.0.0' });
