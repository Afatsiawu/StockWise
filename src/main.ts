import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openDatabase } from './db/connection.js';
import { isSeeded, seedDatabase } from './db/seed.js';
import { startServer } from './server.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const databasePath = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : resolve(projectRoot, 'data/stockwise.db');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const db = openDatabase(databasePath);

if (!isSeeded(db)) {
  console.log('[seed] Empty database - generating 18 months of demo trading history...');
  const summary = seedDatabase(db);
  console.log(
    `[seed] ${summary.products} products, ${summary.sales} sales, ${summary.unitsSold} units over ${summary.startDate} to ${summary.endDate} in ${summary.durationMs}ms (${summary.lostUnits} units lost to stockouts)`,
  );
}

const server = await startServer({ db, port, host, verbose: process.env.HTTP_LOG === 'true' });
console.log(`StockWise running at http://localhost:${server.port} (database: ${databasePath})`);

const shutdown = async (signal: string) => {
  console.log(`\n[${signal}] shutting down`);
  await server.close();
  db.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
