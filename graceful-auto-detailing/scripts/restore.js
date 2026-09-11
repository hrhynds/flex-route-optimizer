/* Puts a backup back. Refuses to run over a database that already has
   customers in it unless told to, because the usual way to lose data twice is
   to restore on top of the wrong thing.

   Usage: npm run restore -- /path/to/graceful-....tar.gz [--force] */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { rm, cp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import config from '../src/config.js';
import { openDb, init, close, q } from '../src/db.js';

const archive = process.argv[2] ? path.resolve(process.argv[2]) : null;
const force = process.argv.includes('--force');

if (!archive || !existsSync(archive)) {
  console.error('Usage: npm run restore -- /path/to/graceful-....tar.gz [--force]');
  process.exit(1);
}

const target = path.join(config.dataDir, 'graceful.sqlite');

if (existsSync(target) && !force) {
  init();
  const customers = q.pluck('SELECT COUNT(*) AS n FROM customers');
  close();
  if (customers > 0) {
    console.error(`There is already a database here with ${customers} customers in it.`);
    console.error(`Move ${config.dataDir} aside first, or pass --force if you are certain.`);
    process.exit(1);
  }
}

const staging = path.join(config.dataDir, `.restore-${Date.now()}`);
mkdirSync(staging, { recursive: true });

try {
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', archive, '-C', staging], { stdio: 'inherit' });
    tar.on('error', reject);
    tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });

  const restoredDb = path.join(staging, 'graceful.sqlite');
  if (!existsSync(restoredDb)) throw new Error('That archive has no database in it.');

  /* Prove it opens and has the shape we expect before displacing anything. */
  const check = openDb(restoredDb);
  const rows = check.prepare('SELECT COUNT(*) AS n FROM customers').get();
  check.close();

  /* WAL side files belong to the old database; leaving them would corrupt the new one. */
  for (const suffix of ['', '-wal', '-shm']) await rm(target + suffix, { force: true });
  await cp(restoredDb, target);

  const photos = path.join(staging, 'uploads');
  if (existsSync(photos)) {
    mkdirSync(config.uploads.dir, { recursive: true });
    await cp(photos, config.uploads.dir, { recursive: true });
  }

  const photoCount = existsSync(config.uploads.dir) ? readdirSync(config.uploads.dir).length : 0;
  console.log(`Restored ${rows.n} customers and ${photoCount} photo${photoCount === 1 ? '' : 's'} into ${config.dataDir}.`);
  console.log('Start the app to check it over.');
} catch (err) {
  console.error('Restore failed:', err.message);
  process.exitCode = 1;
} finally {
  await rm(staging, { recursive: true, force: true });
}
