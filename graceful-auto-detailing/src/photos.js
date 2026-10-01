import { writeFile, unlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import config from './config.js';
import { q, audit } from './db.js';
import { bad, notFound } from './http.js';

const KINDS = ['before', 'after'];

/* Content type is decided by looking at the bytes, never by trusting the
   header the uploader sent. Anything that is not one of these three is
   refused outright, so nothing executable can be stored or served back. */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' };
  }
  return null;
}

export function photosDir() {
  mkdirSync(config.uploads.dir, { recursive: true });
  return config.uploads.dir;
}

export async function savePhoto(appointmentId, buffer, { kind = 'before', caption = '', shared = true, actor = 'owner' }) {
  if (!KINDS.includes(kind)) throw bad('A photo is either a before or an after.');
  if (!buffer?.length) throw bad('No image was received.');
  if (buffer.length > config.uploads.maxBytes) {
    throw bad(`Photos must be under ${Math.floor(config.uploads.maxBytes / (1024 * 1024))} MB.`);
  }
  const kindInfo = sniff(buffer);
  if (!kindInfo) throw bad('That file is not a JPEG, PNG or WebP image.');

  const filename = `${randomBytes(16).toString('hex')}${kindInfo.ext}`;
  await writeFile(path.join(photosDir(), filename), buffer, { mode: 0o600 });

  const res = q.run(
    `INSERT INTO photos(appointment_id, kind, filename, mime, bytes, caption, shared, created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    appointmentId, kind, filename, kindInfo.mime, buffer.length, caption, shared ? 1 : 0, Date.now()
  );
  audit(actor, 'photo.add', 'appointment', appointmentId, { kind, bytes: buffer.length });
  return q.get('SELECT * FROM photos WHERE id = ?', res.id);
}

export function getPhoto(id) {
  const row = q.get('SELECT * FROM photos WHERE id = ?', id);
  if (!row) throw notFound('That photo does not exist.');
  return row;
}

/* Filenames are generated here and never come from a request, but the path is
   still rebuilt from the basename so a tampered row cannot escape the folder. */
export function photoPath(row) {
  const safe = path.basename(String(row.filename));
  if (!safe || safe.startsWith('.')) throw notFound('That photo is missing.');
  const full = path.join(photosDir(), safe);
  if (!full.startsWith(photosDir() + path.sep)) throw notFound('That photo is missing.');
  return full;
}

export async function deletePhoto(id, { actor = 'owner' } = {}) {
  const row = getPhoto(id);
  q.run('DELETE FROM photos WHERE id = ?', id);
  try { await unlink(photoPath(row)); } catch { /* row is gone either way */ }
  audit(actor, 'photo.delete', 'appointment', row.appointment_id, { photoId: id });
  return true;
}

export { KINDS as PHOTO_KINDS };
