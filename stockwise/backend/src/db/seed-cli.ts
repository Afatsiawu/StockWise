import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openDatabase, transaction } from './connection.js';
import { seedDatabase } from './seed.js';

// dist/src/db/seed-cli.js -> project root is three levels up.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const databasePath = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(projectRoot, 'data/stockwise.db');
const args = process.argv.slice(2);
const reset = args.includes('--reset');
const daysIndex = args.indexOf('--days');
const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : undefined;

const db = openDatabase(databasePath);

if (reset) {
  console.log('[seed] Clearing existing data...');
  transaction(db, () => {
    db.exec('DELETE FROM stock_movements');
    db.exec('DELETE FROM sale_items');
    db.exec('DELETE FROM sales');
    db.exec('DELETE FROM products');
    db.exec('DELETE FROM suppliers');
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('stock_movements','sale_items','sales','products','suppliers')");
  });
}

const summary = seedDatabase(db, days ? { days } : {});
console.log(
  JSON.stringify(
    {
      database: databasePath,
      ...summary,
    },
    null,
    2,
  ),
);
db.close();
