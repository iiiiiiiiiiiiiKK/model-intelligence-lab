/**
 * Server entry point. Mounts the app, binds the port, wires graceful shutdown.
 * All application wiring lives in `app.ts` so tests can import it directly.
 */
import { app, bootstrap } from './app';
import { env } from './config';
import { dbFilePath } from './db';
import { listProviders } from './db/mappers';

const { resumedRuns, syncedProviders } = bootstrap();
if (resumedRuns > 0) console.log(`[engine] resumed ${resumedRuns} interrupted run(s)`);
if (syncedProviders > 0) console.log(`[api] applied ${syncedProviders} base URL(s) from environment`);

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`[api] Model Intelligence Lab listening on http://${env.HOST}:${env.PORT}`);
  console.log(`[api] database: ${dbFilePath}`);
  const summary = listProviders()
    .map((provider) => {
      if (!provider.hasCredential) return `${provider.name}=no-key`;
      return `${provider.name}=key(${provider.credentialSource})`;
    })
    .join(' ');
  console.log(`[api] providers: ${summary}`);
  console.log('[api] keys can be added or changed at runtime from Settings → Providers');
});

function shutdown(signal: string) {
  console.log(`[api] ${signal} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app };
