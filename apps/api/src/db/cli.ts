import { loadConfig } from '../config.js';
import { createDb } from './client.js';
import { migrate } from './migrations.js';
import { seed } from './seed.js';

const cmd = process.argv[2];
const cfg = loadConfig();
const db = await createDb({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR });
try {
  if (cmd === 'migrate' || cmd === 'seed') {
    const ran = await migrate(db);
    console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Schema up to date');
  }
  if (cmd === 'seed') {
    await seed(db);
    console.log('Seeded demo users');
  }
  if (cmd !== 'migrate' && cmd !== 'seed') {
    console.error('Usage: db:migrate | db:seed');
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
