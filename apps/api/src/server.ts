import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrations.js';
import { seed } from './db/seed.js';
import { SmtpMailer, createMailer } from './integrations/mailer.js';
import { MockSapClient, ServiceLayerSapClient } from './integrations/sap.js';
import { localStorage } from './storage.js';

const cfg = loadConfig();
const db = await createDb({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR });
await migrate(db);
if (cfg.AUTH_MODE === 'dev') await seed(db);

const sap =
  cfg.SAP_MODE === 'service_layer'
    ? new ServiceLayerSapClient({
        baseUrl: cfg.SAP_BASE_URL,
        companyDb: cfg.SAP_COMPANY_DB,
        username: cfg.SAP_USERNAME,
        password: cfg.SAP_PASSWORD,
      })
    : new MockSapClient();

const mailer = createMailer(cfg, (line) => console.log(line));
if (mailer instanceof SmtpMailer) {
  await mailer.verify().then(
    () => console.log(`SMTP ready (${cfg.SMTP_HOST}:${cfg.SMTP_PORT})`),
    (err: Error) => console.error(`SMTP check failed: ${err.message} — vendor sign-in emails will not be delivered`),
  );
}
const app = await buildApp({ cfg, db, storage: localStorage(cfg.UPLOAD_DIR), sap, mailer });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: cfg.PORT, host: cfg.HOST });
app.log.info(`API docs at http://localhost:${cfg.PORT}/docs (db: ${db.driver}, sap: ${cfg.SAP_MODE})`);
