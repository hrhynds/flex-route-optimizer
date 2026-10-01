import { bad } from './http.js';

/* Every field that reaches the database goes through one of these.
   They throw a 400 with a message a person can act on, never a stack trace. */

/* Control characters have no place in any field. Tab, newline and carriage
   return are let through because long text fields legitimately contain them. */
function hasControlChars(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) return true;
  }
  return false;
}

export function str(value, field, { min = 0, max = 500, trim = true, optional = false, fallback = '' } = {}) {
  if (value === undefined || value === null) {
    if (optional) return fallback;
    throw bad(`${field} is required.`);
  }
  if (typeof value !== 'string') throw bad(`${field} must be text.`);
  const out = trim ? value.trim() : value;
  if (out.length < min) throw bad(min === 1 ? `${field} is required.` : `${field} must be at least ${min} characters.`);
  if (out.length > max) throw bad(`${field} must be ${max} characters or fewer.`);
  if (hasControlChars(out)) throw bad(`${field} contains characters that are not allowed.`);
  return out;
}

export function text(value, field, opts = {}) {
  return str(value, field, { max: 4000, ...opts });
}

export function int(value, field, { min = -2147483648, max = 2147483647, optional = false, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw bad(`${field} is required.`);
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw bad(`${field} must be a whole number.`);
  if (n < min || n > max) throw bad(`${field} must be between ${min} and ${max}.`);
  return n;
}

/* Money always travels as integer cents. The server never trusts a total the
   client worked out for itself. */
export function cents(value, field, { min = 0, max = 10000000, optional = false, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw bad(`${field} is required.`);
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw bad(`${field} must be an amount.`);
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) > 1e-6) throw bad(`${field} must be a whole number of cents.`);
  if (rounded < min || rounded > max) throw bad(`${field} must be between ${money(min)} and ${money(max)}.`);
  return rounded;
}

export function bool(value, field, { optional = true, fallback = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return fallback;
    throw bad(`${field} is required.`);
  }
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw bad(`${field} must be yes or no.`);
}

export function oneOf(value, field, allowed, { optional = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw bad(`${field} is required.`);
  }
  const v = String(value);
  if (!allowed.includes(v)) throw bad(`${field} must be one of: ${allowed.join(', ')}.`);
  return v;
}

export function timestamp(value, field, { optional = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw bad(`${field} is required.`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw bad(`${field} must be a date and time.`);
  const ms = Math.round(n);
  /* 2000-01-01 .. 2100-01-01, which also rules out a seconds/milliseconds mix-up. */
  if (ms < 946684800000 || ms > 4102444800000) throw bad(`${field} is not a sensible date.`);
  return ms;
}

export function email(value, field, { optional = true, fallback = '' } = {}) {
  const raw = str(value, field, { max: 254, optional, fallback });
  if (!raw) return fallback;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(raw)) throw bad(`${field} does not look like an email address.`);
  return raw.toLowerCase();
}

/* Stored in E.164 where possible, because that is what an SMS provider wants.
   A bare 10-digit US number is assumed to be +1; anything already in + form is kept. */
export function phone(value, field, { optional = true, fallback = '' } = {}) {
  const raw = str(value, field, { max: 32, optional, fallback });
  if (!raw) return fallback;
  const plus = raw.trim().startsWith('+');
  const digits = raw.replace(/\D+/g, '');
  if (digits.length < 7) throw bad(`${field} is too short to be a phone number.`);
  if (digits.length > 15) throw bad(`${field} is too long to be a phone number.`);
  if (plus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export function lat(value, field, { optional = true, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw bad(`${field} is required.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < -90 || n > 90) throw bad(`${field} must be a latitude between -90 and 90.`);
  return n;
}

export function lng(value, field, { optional = true, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw bad(`${field} is required.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < -180 || n > 180) throw bad(`${field} must be a longitude between -180 and 180.`);
  return n;
}

export function idList(value, field, { max = 50 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw bad(`${field} must be a list.`);
  if (value.length > max) throw bad(`${field} may hold at most ${max} items.`);
  return value.map((v, i) => int(v, `${field} entry ${i + 1}`, { min: 1 }));
}

export function money(c) {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(Math.round(c));
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}
