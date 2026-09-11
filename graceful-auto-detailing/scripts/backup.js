/* Takes a consistent snapshot of everything the business would hate to lose:
   the database and the before/after photos, in one file.

   SQLite is copied with its own online backup, not by copying the file, so a
   snapshot taken while the app is serving is still a valid database rather
   than a half-written one.

   Usage: npm run backup [-- /where/to/put/it] */
import { backup } from 'node:sqlite';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import config from '../src/config.js';
import { init, close, q } from '../src/db.js';

const outDir = path.resolve(process.argv[2] || path.join(config.dataDir, 'backups'));
mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const workDir = path.join(outDir, `.work-${stamp}`);
mkdirSync(workDir, { recursive: true });

const db = init();
const snapshot = path.join(workDir, 'graceful.sqlite');

try {
  const pages = await backup(db, snapshot);

  const counts = {
    customers: q.pluck('SELECT COUNT(*) AS n FROM customers'),
    appointments: q.pluck('SELECT COUNT(*) AS n FROM appointments'),
    invoices: q.pluck('SELECT COUNT(*) AS n FROM invoices'),
    photos: q.pluck('SELECT COUNT(*) AS n FROM photos'),
  };

  const photoDir = config.uploads.dir;
  const photoCount = existsSync(photoDir) ? readdirSync(photoDir).length : 0;

  /* tar is on every machine this will ever run on, and keeping the archive in
     a standard format means a restore never depends on this app existing. */
  const archive = path.join(outDir, `graceful-${stamp}.tar.gz`);
  const args = ['-czf', archive, '-C', workDir, 'graceful.sqlite'];
  if (photoCount > 0) args.push('-C', path.dirname(photoDir), path.basename(photoDir));

  await new Promise((resolve, reject) => {
    const tar = spawn('tar', args, { stdio: 'inherit' });
    tar.on('error', reject);
    tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });

  const size = statSync(archive).size;
  console.log(`Backed up to ${archive}`);
  console.log(`  ${(size / 1024 / 1024).toFixed(2)} MB · ${pages} database pages · ${photoCount} photo${photoCount === 1 ? '' : 's'}`);
  console.log(`  ${counts.customers} customers · ${counts.appointments} appointments · ${counts.invoices} invoices`);
  console.log('');
  console.log('Keep a copy somewhere that is not this machine.');
} catch (err) {
  console.error('Backup failed:', err.message);
  process.exitCode = 1;
} finally {
  await rm(workDir, { recursive: true, force: true });
  close();
}
