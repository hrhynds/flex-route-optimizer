import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(PUBLIC);
const scripts = files.filter((f) => f.endsWith('.js'));
const pages = files.filter((f) => f.endsWith('.html'));
const rel = (f) => path.relative(PUBLIC, f);

describe('the browser code cannot turn data into markup', () => {
  for (const file of scripts) {
    test(`${rel(file)} never assigns innerHTML or outerHTML`, () => {
      const source = readFileSync(file, 'utf8');
      /* A mention in a comment is fine; an assignment is not. */
      assert.ok(!/\.(inner|outer)HTML\s*=/.test(source), 'found an HTML assignment');
      assert.ok(!/insertAdjacentHTML/.test(source), 'found insertAdjacentHTML');
      assert.ok(!/document\.write/.test(source), 'found document.write');
    });

    test(`${rel(file)} never evaluates a string`, () => {
      const source = readFileSync(file, 'utf8');
      assert.ok(!/\beval\s*\(/.test(source), 'found eval');
      assert.ok(!/new\s+Function\s*\(/.test(source), 'found new Function');
      /* setTimeout with a string argument is eval by another name. */
      assert.ok(!/set(Timeout|Interval)\s*\(\s*['"`]/.test(source), 'found a string timer');
    });
  }
});

describe('the pages satisfy the strict content policy', () => {
  for (const file of pages) {
    test(`${rel(file)} has no inline script or style`, () => {
      const source = readFileSync(file, 'utf8');
      assert.ok(!/<script(?![^>]*\bsrc=)/i.test(source), 'found an inline <script>');
      assert.ok(!/<style[\s>]/i.test(source), 'found an inline <style>');
      assert.ok(!/\sstyle\s*=\s*["']/i.test(source), 'found a style attribute');
      assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(source), 'found an inline event handler');
    });
  }

  test('no page pulls anything from another origin', () => {
    for (const file of pages) {
      const source = readFileSync(file, 'utf8');
      const externals = [...source.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/gi)];
      assert.equal(externals.length, 0, `${rel(file)} loads ${externals[0]?.[0]}`);
    }
  });

  test('the customer-facing pages ask not to be indexed', () => {
    for (const name of ['portal/index.html', 'track/index.html', 'admin/index.html']) {
      const source = readFileSync(path.join(PUBLIC, name), 'utf8');
      assert.match(source, /name="robots"\s+content="noindex/, name);
    }
  });
});

describe('map links and coordinates', () => {
  test('a pin can be read from what people actually paste', async () => {
    const { parseCoordinates } = await import('../public/shared/ui.js');
    const expected = { lat: 42.7981, lng: -83.7049 };
    const accepted = [
      '42.7981, -83.7049',
      '42.7981,-83.7049',
      'https://www.google.com/maps/@42.7981,-83.7049,17z',
      'https://www.google.com/maps/place/Somewhere/@42.7981,-83.7049,17z/data=!3m1!4b1',
      'https://maps.apple.com/?ll=42.7981,-83.7049&q=Home',
      'https://maps.google.com/?q=42.7981,-83.7049',
    ];
    for (const input of accepted) {
      assert.deepEqual(parseCoordinates(input), expected, input);
    }
  });

  test('anything that is not a coordinate is refused rather than guessed at', async () => {
    const { parseCoordinates } = await import('../public/shared/ui.js');
    for (const input of ['', '   ', 'not a location', '412 Lakeshore Dr, Fenton, MI', '999,999', '91,0', '0,181']) {
      assert.equal(parseCoordinates(input), null, JSON.stringify(input));
    }
  });
});

describe('money and time on the client agree with the server', () => {
  test('cents are formatted the same way on both sides', async () => {
    const ui = await import('../public/shared/ui.js');
    const server = await import('../src/validate.js');
    for (const cents of [0, 5, 999, 1000, 2000, 8000, 30000, 123456]) {
      assert.equal(ui.money(cents), server.money(cents), `${cents} cents`);
    }
  });

  test('a price list drops the cents only when they are zero', async () => {
    const { price } = await import('../public/shared/ui.js');
    assert.equal(price(2000), '$20');
    assert.equal(price(8000), '$80');
    assert.equal(price(1999), '$19.99');
  });

  test('a time splits into hour, minute and period without duplicating the period', async () => {
    const { timeParts } = await import('../public/shared/ui.js');
    const nineThirty = Date.UTC(2026, 8, 11, 9, 30);
    const parts = timeParts(nineThirty);
    assert.match(parts.hour, /^\d{1,2}$/, 'the hour is just a number');
    assert.match(parts.minute, /^\d{2}$/, 'the minute keeps two digits');
    assert.match(parts.period, /^(AM|PM)$/, 'the period stands on its own');
  });
});

describe('the brand is wired up and self-contained', () => {
  test('every face the stylesheet asks for exists on disk', () => {
    const css = readFileSync(path.join(PUBLIC, 'shared/fonts.css'), 'utf8');
    const refs = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(refs.length >= 6, `expected the brand's faces, found ${refs.length}`);
    for (const ref of refs) {
      const file = path.join(PUBLIC, 'shared', ref);
      assert.ok(statSync(file).size > 4000, `${ref} is missing or truncated`);
    }
  });

  test('the fonts are served from here, never from a third party', () => {
    const css = readFileSync(path.join(PUBLIC, 'shared/fonts.css'), 'utf8');
    assert.ok(!/https?:/.test(css), 'a font is being pulled from another origin');
    for (const family of ['Barlow Condensed', 'Rajdhani']) {
      assert.ok(css.includes(family), `${family} is not declared`);
    }
  });

  test('every page loads the brand faces and declares the dark ground', () => {
    for (const file of pages) {
      const source = readFileSync(file, 'utf8');
      assert.match(source, /href="\/shared\/fonts\.css"/, `${rel(file)} does not load the fonts`);
      assert.match(source, /name="theme-color" content="#000000"/, `${rel(file)} does not paint the browser chrome black`);
    }
  });

  test('the palette is the one the website uses', () => {
    const css = readFileSync(path.join(PUBLIC, 'shared/base.css'), 'utf8');
    /* Taken from gracefulautodetail.com's own custom properties. */
    const brand = {
      '--black': '#000000',
      '--panel': '#080808',
      '--blue': '#1565c8',
      '--blue-bright': '#2b8af5',
      '--blue-light': '#5aaeff',
      '--silver': '#b8bdc8',
      '--chrome': '#e2e5ea',
    };
    for (const [name, value] of Object.entries(brand)) {
      assert.match(css, new RegExp(`${name}\\s*:\\s*${value}\\b`, 'i'), `${name} should be ${value}`);
    }
  });

  test('no emoji are left in the interface chrome', () => {
    /* The brand is sharp and monochrome; colour emoji fight it. Icons are SVG. */
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const file of [...scripts, ...pages]) {
      const source = readFileSync(file, 'utf8');
      const hits = source.split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => emoji.test(line));
      assert.equal(hits.length, 0, `${rel(file)}:${hits[0]?.[0]} still has an emoji: ${hits[0]?.[1].trim().slice(0, 70)}`);
    }
  });
});
