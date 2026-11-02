/**
 * Standalone worker process. Run API replicas with WORKER_ENABLED=false and scale
 * this independently: `npm run worker -w @vo/api`.
 */
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrations.js';
import { MockSapClient, ServiceLayerSapClient } from './integrations/sap.js';
import { Worker } from './jobs/worker.js';
import { localStorage } from './storage.js';

const cfg = loadConfig();
const db = await createDb({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR });
await migrate(db);
const sap =
  cfg.SAP_MODE === 'service_layer'
    ? new ServiceLayerSapClient({ baseUrl: cfg.SAP_BASE_URL, companyDb: cfg.SAP_COMPANY_DB, username: cfg.SAP_USERNAME, password: cfg.SAP_PASSWORD })
    : new MockSapClient();

const worker = new Worker({ cfg, db, storage: localStorage(cfg.UPLOAD_DIR), sap }, console, cfg.WORKER_POLL_MS);
worker.start();
console.log(`worker started (db: ${db.driver}, sap: ${cfg.SAP_MODE})`);

const stop = async () => {
  await worker.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
