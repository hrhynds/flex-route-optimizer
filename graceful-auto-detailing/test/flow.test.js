import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, startServer, makeClient, OWNER } from './helpers.js';

const box = isolate();
let ctx, admin;

before(async () => {
  ctx = await startServer();
  admin = makeClient(ctx.base);
});
after(async () => {
  await new Promise((r) => ctx.server.close(r));
  const { close } = await import('../src/db.js');
  close();
  box.cleanup();
});

/* State shared down the flow. */
const S = {};

describe('first run and sign in', () => {
  test('a fresh install asks to be set up', async () => {
    const { status, data } = await admin.get('/api/admin/bootstrap');
    assert.equal(status, 200);
    assert.equal(data.needs_setup, true);
    assert.equal(data.signed_in, false);
  });

  test('setup refuses a wrong code', async () => {
    const { status } = await admin.post('/api/admin/setup', {
      code: 'NOPE', email: OWNER.email, password: OWNER.password,
    });
    assert.equal(status, 403);
  });

  test('setup refuses a weak password even with the right code', async () => {
    const { ensureSetupCode } = await import('../src/auth.js');
    const { status, data } = await admin.post('/api/admin/setup', {
      code: ensureSetupCode(), email: OWNER.email, password: 'short',
    });
    assert.equal(status, 400);
    assert.match(data.error, /12 characters/);
  });

  test('setup succeeds once, and signs the owner in', async () => {
    const { ensureSetupCode } = await import('../src/auth.js');
    const { status, data } = await admin.post('/api/admin/setup', {
      code: ensureSetupCode(), email: OWNER.email, password: OWNER.password,
      name: 'Grace', business_name: 'Graceful Auto Detailing',
    });
    assert.equal(status, 200);
    assert.equal(data.owner.email, OWNER.email);
    assert.ok(admin.cookies.get('gad_session'), 'a session cookie was set');
    assert.ok(admin.cookies.get('gad_csrf'), 'a csrf cookie was set');
  });

  test('setup cannot be run a second time', async () => {
    const { status } = await admin.post('/api/admin/setup', {
      code: 'ANY', email: 'other@x.test', password: 'another-long-passphrase',
    });
    assert.equal(status, 403);
  });
});

describe('services and add-ons', () => {
  test('the price list ships with the add-ons the business actually sells', async () => {
    const { data } = await admin.get('/api/admin/catalog');
    const byName = Object.fromEntries(data.addons.map((a) => [a.name, a]));
    assert.equal(byName['Trim restoration'].price_cents, 2000);
    assert.equal(byName['Spray wax'].price_cents, 1000);
    assert.equal(byName['Clay bar with long-lasting wax'].price_cents, 6000);
    assert.equal(byName['Pet hair removal'].price_cents, 4000);
    assert.equal(byName['Headlight restoration'].price_cents, 8000);
    assert.equal(byName['Headlight restoration'].price_is_from, 1, 'headlights are a "starting at" price');
    for (const a of data.addons) assert.ok(a.description.length > 20, `${a.name} has a friendly description`);
    S.addons = byName;
    S.services = data.services;
  });

  test('any price can be edited at any time', async () => {
    const target = S.addons['Spray wax'];
    const { status, data } = await admin.patch(`/api/admin/catalog/addons/${target.id}`, { price_cents: 1250 });
    assert.equal(status, 200);
    assert.equal(data.item.price_cents, 1250);
    await admin.patch(`/api/admin/catalog/addons/${target.id}`, { price_cents: 1000 });
  });

  test('a new add-on can be created and retired', async () => {
    const { data } = await admin.post('/api/admin/catalog/addons', {
      name: 'Engine bay clean', price_cents: 3500, description: 'Degreased, rinsed and dressed so it looks cared for.',
    });
    assert.equal(data.item.price_cents, 3500);
    const del = await admin.del(`/api/admin/catalog/addons/${data.item.id}`);
    assert.equal(del.data.deleted, true);
  });

  test('a negative price is refused', async () => {
    const { status } = await admin.post('/api/admin/catalog/addons', { name: 'Bad', price_cents: -100 });
    assert.equal(status, 400);
  });
});

describe('customers, vehicles and appointments', () => {
  test('a customer is created with a vehicle', async () => {
    const { status, data } = await admin.post('/api/admin/customers', {
      name: 'Dana Whitfield',
      phone: '(810) 555-0134',
      email: 'dana@example.test',
      address: '412 Lakeshore Dr, Fenton, MI',
      vehicle: { year: '2019', make: 'Toyota', model: 'Tacoma', color: 'Silver' },
    });
    assert.equal(status, 200);
    assert.equal(data.customer.phone, '+18105550134', 'the phone is normalised for texting');
    assert.equal(data.customer.vehicles.length, 1);
    S.customer = data.customer;
  });

  test('an appointment is booked against that customer and vehicle', async () => {
    const service = S.services.find((s) => s.name === 'Full Interior Detail');
    const { status, data } = await admin.post('/api/admin/appointments', {
      customer_id: S.customer.id,
      vehicle_id: S.customer.vehicles[0].id,
      service_id: service.id,
      starts_at: Date.now() + 2 * 60 * 60 * 1000,
      address: '412 Lakeshore Dr, Fenton, MI',
      lat: 42.7981, lng: -83.7049,
      notes: 'Dog rides in the back seat.',
    });
    assert.equal(status, 200);
    assert.equal(data.appointment.status, 'scheduled');
    assert.equal(data.appointment.totals.subtotal_cents, service.price_cents);
    S.appt = data.appointment;
    S.service = service;
  });

  test("a vehicle belonging to someone else cannot be attached", async () => {
    const other = await admin.post('/api/admin/customers', { name: 'Someone Else', phone: '8105550199' });
    const vehicle = await admin.post(`/api/admin/customers/${other.data.customer.id}/vehicles`, {
      make: 'Honda', model: 'Civic',
    });
    const { status, data } = await admin.patch(`/api/admin/appointments/${S.appt.id}`, {
      vehicle_id: vehicle.data.vehicle.id,
    });
    assert.equal(status, 400);
    assert.match(data.error, /belongs to someone else/);
  });

  test('the admin adds an add-on and the total moves', async () => {
    const before = S.appt.totals.subtotal_cents;
    const { data } = await admin.post(`/api/admin/appointments/${S.appt.id}/addons`, {
      addon_id: S.addons['Pet hair removal'].id,
    });
    assert.equal(data.totals.subtotal_cents, before + 4000);
  });

  test('a status may not jump straight from scheduled to completed', async () => {
    const { status, data } = await admin.post(`/api/admin/appointments/${S.appt.id}/status`, { status: 'completed' });
    assert.equal(status, 409);
    assert.match(data.error, /cannot move straight to/);
  });
});

describe('the customer link', () => {
  test('the owner mints a link and it opens the appointment', async () => {
    const { status, data } = await admin.post(`/api/admin/appointments/${S.appt.id}/portal-link`, {});
    assert.equal(status, 200);
    assert.match(data.url, /\/p\/[A-Za-z0-9_-]{40,}$/);
    S.portalToken = data.url.split('/p/')[1];
    S.customerClient = makeClient(ctx.base);

    const view = await S.customerClient.get(`/api/portal/${S.portalToken}`);
    assert.equal(view.status, 200);
    assert.equal(view.data.appointment.service_name, 'Full Interior Detail');
    assert.equal(view.data.appointment.vehicle_label, '2019 Silver Toyota Tacoma');
    assert.equal(view.data.business.name, 'Graceful Auto Detailing');
    S.portal = view.data;
  });

  test('the customer never receives the owner private notes', async () => {
    const serialised = JSON.stringify(S.portal);
    assert.ok(!serialised.includes('Dog rides in the back seat'), 'owner notes stay on the admin side');
    assert.ok(!('notes' in S.portal.appointment), 'no notes field at all');
    assert.ok(!serialised.includes('Someone Else'), 'no other customer appears');
  });

  test('extras carry friendly wording and an immediate price', async () => {
    const offered = S.portal.available_addons;
    assert.ok(offered.length >= 4);
    const headlights = offered.find((a) => a.name === 'Headlight restoration');
    assert.equal(headlights.price_cents, 8000);
    assert.equal(headlights.price_is_from, true);
    assert.match(headlights.description, /Cloudy/);
  });

  test('the customer adds an extra and the total updates on the spot', async () => {
    const before = S.portal.totals.total_cents;
    const trim = S.portal.available_addons.find((a) => a.name === 'Trim restoration');
    const { status, data } = await S.customerClient.post(`/api/portal/${S.portalToken}/addons`, { addon_id: trim.id });
    assert.equal(status, 200);
    assert.equal(data.totals.total_cents, before + 2000);
    const added = data.totals.addons.find((a) => a.name === 'Trim restoration');
    assert.equal(added.added_by_you, true);
    S.trimLineId = added.line_id;
  });

  test('the customer can take back their own extra but not one the owner added', async () => {
    const mine = await S.customerClient.del(`/api/portal/${S.portalToken}/addons/${S.trimLineId}`);
    assert.equal(mine.status, 200);
    assert.ok(!mine.data.totals.addons.some((a) => a.name === 'Trim restoration'));

    const ownerLine = mine.data.totals.addons.find((a) => a.name === 'Pet hair removal');
    const theirs = await S.customerClient.del(`/api/portal/${S.portalToken}/addons/${ownerLine.line_id}`);
    assert.equal(theirs.status, 403);

    /* Put it back so the rest of the flow prices the same job. */
    const trim = mine.data.available_addons.find((a) => a.name === 'Trim restoration');
    await S.customerClient.post(`/api/portal/${S.portalToken}/addons`, { addon_id: trim.id });
  });

  test('the owner sees what the customer did', async () => {
    const { data } = await admin.get(`/api/admin/appointments/${S.appt.id}`);
    const names = data.appointment.totals.addons.map((a) => a.name);
    assert.deepEqual(names.sort(), ['Pet hair removal', 'Trim restoration']);
    assert.equal(data.appointment.totals.subtotal_cents, 15000 + 4000 + 2000);
  });
});

describe('"I am on my way"', () => {
  test('no location exists before the button is pressed', async () => {
    const tracking = await S.customerClient.get(`/api/portal/${S.portalToken}/tracking`);
    assert.equal(tracking.data.live, false);
    assert.ok(!('position' in tracking.data), 'no position field at all when nothing is running');

    const page = await S.customerClient.get(`/api/portal/${S.portalToken}`);
    assert.equal(page.data.tracking.live, false);
    assert.ok(!('position' in page.data.tracking), 'the appointment page carries no position either');

    const { q } = await import('../src/db.js');
    assert.equal(q.pluck('SELECT COUNT(*) AS n FROM trip_pings'), 0);
    assert.equal(q.pluck('SELECT COUNT(*) AS n FROM trips'), 0);
  });

  test('pressing it starts a trip, sets the status and texts a tracking link', async () => {
    const { status, data } = await admin.post(`/api/admin/appointments/${S.appt.id}/on-my-way`, {
      lat: 42.9634, lng: -83.3527, accuracy_m: 12, send_text: true,
    });
    assert.equal(status, 200);
    assert.equal(data.appointment.status, 'on_my_way');
    assert.equal(data.trip.minutes, 60, 'one hour by default');
    assert.match(data.trip.url, /\/t\/[A-Za-z0-9_-]{40,}$/);
    assert.ok(data.message.body.includes(data.trip.url), 'the text carries the tracking link');
    assert.match(data.message.body, /expires in 60 min/);
    S.trackToken = data.trip.url.split('/t/')[1];
    S.tripExpiresAt = data.trip.expires_at;
  });

  test('the tracking link shows a position, a distance and an ETA', async () => {
    const stranger = makeClient(ctx.base);
    const { status, data } = await stranger.get(`/api/track/${S.trackToken}`);
    assert.equal(status, 200);
    assert.equal(data.live, true);
    assert.ok(data.position.lat && data.position.lng);
    assert.ok(data.distance_m > 1000, 'a real distance');
    assert.ok(data.eta_minutes > 0, 'a real ETA');
    assert.equal(data.destination.lat, 42.7981);
    assert.equal(data.business.name, 'Graceful Auto Detailing');
  });

  test('the link expires in an hour, not later', async () => {
    const { data } = await makeClient(ctx.base).get(`/api/track/${S.trackToken}`);
    const minutesLeft = data.seconds_left / 60;
    assert.ok(minutesLeft > 59 && minutesLeft <= 60, `about an hour left, got ${minutesLeft}`);
  });

  test('moving closer shortens the ETA', async () => {
    const first = await makeClient(ctx.base).get(`/api/track/${S.trackToken}`);
    await admin.post(`/api/admin/appointments/${S.appt.id}/ping`, {
      lat: 42.8200, lng: -83.7100, accuracy_m: 8, speed_mps: 14,
    });
    const second = await makeClient(ctx.base).get(`/api/track/${S.trackToken}`);
    assert.ok(second.data.distance_m < first.data.distance_m, 'distance came down');
    assert.ok(second.data.eta_minutes < first.data.eta_minutes, 'ETA came down');
    assert.equal(second.data.trail.length, 2, 'a short trail is kept for the map');
  });

  test('the customer can follow along from their own appointment page too', async () => {
    const { data } = await S.customerClient.get(`/api/portal/${S.portalToken}/tracking`);
    assert.equal(data.live, true);
    assert.ok(data.position.lat);
    assert.ok(data.eta_minutes > 0);
  });

  test('stopping tracking ends it and erases every trace of where the owner was', async () => {
    const stop = await admin.post(`/api/admin/appointments/${S.appt.id}/stop-tracking`, {});
    assert.equal(stop.data.stopped, true);

    const after = await makeClient(ctx.base).get(`/api/track/${S.trackToken}`);
    assert.equal(after.status, 404, 'the link stops working immediately');

    const { q } = await import('../src/db.js');
    assert.equal(q.pluck('SELECT COUNT(*) AS n FROM trip_pings'), 0, 'the trail is deleted');
    const row = q.get('SELECT last_lat, last_lng, distance_m, eta_at FROM trips WHERE id = ?', 1);
    assert.equal(row.last_lat, null);
    assert.equal(row.last_lng, null);
    assert.equal(row.distance_m, null);

    const portalTracking = await S.customerClient.get(`/api/portal/${S.portalToken}/tracking`);
    assert.equal(portalTracking.data.live, false);
  });
});

describe('doing the job and getting paid', () => {
  test('before and after photos upload and reach the customer', async () => {
    /* A one-pixel PNG is enough to prove the byte-sniffing path. */
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const before = await admin.raw('POST', `/api/admin/appointments/${S.appt.id}/photos?kind=before&caption=Rear%20seats`, {
      body: new Uint8Array(png), headers: { 'Content-Type': 'image/png' },
    });
    assert.equal(before.status, 200);
    assert.equal(before.data.photo.kind, 'before');

    const after = await admin.raw('POST', `/api/admin/appointments/${S.appt.id}/photos?kind=after`, {
      body: new Uint8Array(png), headers: { 'Content-Type': 'image/png' },
    });
    assert.equal(after.status, 200);
    S.photoId = after.data.photo.id;

    const view = await S.customerClient.get(`/api/portal/${S.portalToken}`);
    assert.equal(view.data.photos.length, 2);
    const img = await S.customerClient.raw('GET', view.data.photos[0].url, { json: false });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
  });

  test('a file that is not an image is refused', async () => {
    const notAnImage = Buffer.from('<?php echo "hello"; ?>', 'utf8');
    const { status, data } = await admin.raw('POST', `/api/admin/appointments/${S.appt.id}/photos?kind=after`, {
      body: new Uint8Array(notAnImage), headers: { 'Content-Type': 'image/png' },
    });
    assert.equal(status, 400);
    assert.match(data.error, /not a JPEG, PNG or WebP/);
  });

  test('a photo can be kept off the customer page', async () => {
    await admin.patch(`/api/admin/photos/${S.photoId}`, { shared: false });
    const view = await S.customerClient.get(`/api/portal/${S.portalToken}`);
    assert.equal(view.data.photos.length, 1, 'the unshared one is gone from the customer view');
    const hidden = await S.customerClient.raw('GET', `/api/portal/${S.portalToken}/photo/${S.photoId}`, { json: false });
    assert.equal(hidden.status, 404, 'and cannot be fetched directly either');
    await admin.patch(`/api/admin/photos/${S.photoId}`, { shared: true });
  });

  test('the job runs through to completed', async () => {
    await admin.post(`/api/admin/appointments/${S.appt.id}/status`, { status: 'arrived' });
    await admin.post(`/api/admin/appointments/${S.appt.id}/status`, { status: 'in_progress' });
    const { data } = await admin.post(`/api/admin/appointments/${S.appt.id}/status`, { status: 'completed', notify: true });
    assert.equal(data.appointment.status, 'completed');
    assert.ok(data.message.body.includes('/p/'), 'the finish text carries their link');
  });

  test('the invoice is built from what was actually done', async () => {
    const { status, data } = await admin.post(`/api/admin/appointments/${S.appt.id}/invoice`, {});
    assert.equal(status, 200);
    assert.equal(data.invoice.status, 'draft');
    assert.equal(data.invoice.items.length, 3, 'service plus two add-ons');
    assert.equal(data.invoice.subtotal_cents, 15000 + 4000 + 2000);
    assert.equal(data.invoice.total_cents, 21000);
    assert.match(data.invoice.number, /^GAD-\d+$/);
    S.invoice = data.invoice;
  });

  test('a draft invoice is not visible to the customer', async () => {
    const view = await S.customerClient.get(`/api/portal/${S.portalToken}`);
    assert.equal(view.data.invoice, null);
  });

  test('a discount reduces the total', async () => {
    const { data } = await admin.patch(`/api/admin/invoices/${S.invoice.id}`, { discount_cents: 1000 });
    assert.equal(data.invoice.total_cents, 20000);
    await admin.patch(`/api/admin/invoices/${S.invoice.id}`, { discount_cents: 0 });
  });

  test('issuing it makes it visible, and money cannot be recorded before then', async () => {
    const tooEarly = await admin.post(`/api/admin/invoices/${S.invoice.id}/payments`, { amount_cents: 1000 });
    assert.equal(tooEarly.status, 409);

    const { data } = await admin.post(`/api/admin/invoices/${S.invoice.id}/issue`, { send_text: true });
    assert.equal(data.invoice.status, 'sent');
    assert.ok(data.message.body.includes('$210.00'), 'the text quotes the real total');

    const view = await S.customerClient.get(`/api/portal/${S.portalToken}`);
    assert.equal(view.data.invoice.number, S.invoice.number);
    assert.equal(view.data.invoice.balance_cents, 21000);
    assert.equal(view.data.invoice.can_tip, true);
  });

  test('the customer leaves a tip and the balance grows by exactly that', async () => {
    const { status, data } = await S.customerClient.post(`/api/portal/${S.portalToken}/tip`, { tip_cents: 3000 });
    assert.equal(status, 200);
    assert.equal(data.invoice.tip_cents, 3000);
    assert.equal(data.invoice.total_cents, 24000);
    assert.equal(data.invoice.balance_cents, 24000);
  });

  test('saying how they will pay does not mark anything as paid', async () => {
    const { status } = await S.customerClient.post(`/api/portal/${S.portalToken}/paying`, { method: 'zelle' });
    assert.equal(status, 200);
    const view = await S.customerClient.get(`/api/portal/${S.portalToken}`);
    assert.equal(view.data.invoice.paid_cents, 0, 'only the owner can record money as received');
    assert.equal(view.data.invoice.status, 'sent');
  });

  test('the owner records the money and the invoice settles', async () => {
    const { data } = await admin.post(`/api/admin/invoices/${S.invoice.id}/payments`, {
      amount_cents: 24000, tip_cents: 3000, method: 'zelle', reference: 'ZL-8891',
    });
    assert.equal(data.invoice.status, 'paid');
    assert.equal(data.invoice.balance_cents, 0);
    assert.ok(data.invoice.paid_at);
  });

  test('a tip cannot be changed after the invoice is settled', async () => {
    const { status } = await S.customerClient.post(`/api/portal/${S.portalToken}/tip`, { tip_cents: 9900 });
    assert.equal(status, 409);
  });

  test('the customer leaves a review, and it is not published until the owner says so', async () => {
    const { status, data } = await S.customerClient.post(`/api/portal/${S.portalToken}/review`, {
      rating: 5, comment: 'Truck looks better than the day I bought it.',
    });
    assert.equal(status, 200);
    assert.equal(data.review.rating, 5);

    const list = await admin.get('/api/admin/reviews');
    assert.equal(list.data.reviews[0].published, false);
    const published = await admin.patch(`/api/admin/reviews/${list.data.reviews[0].id}`, { published: true });
    assert.equal(published.data.review.published, 1);
  });

  test('an invalid rating is refused', async () => {
    const { status } = await S.customerClient.post(`/api/portal/${S.portalToken}/review`, { rating: 9 });
    assert.equal(status, 400);
  });

  test('the dashboard reports the week honestly', async () => {
    const { data } = await admin.get('/api/admin/dashboard');
    assert.equal(data.stats.week_collected_cents, 24000);
    assert.equal(data.stats.outstanding_cents, 0);
  });
});

describe('money already agreed does not move under anyone', () => {
  test('raising a price does not re-price a job that is already booked', async () => {
    const petHair = S.addons['Pet hair removal'];
    const before = (await admin.get(`/api/admin/appointments/${S.appt.id}`)).data.appointment.totals;

    await admin.patch(`/api/admin/catalog/addons/${petHair.id}`, { price_cents: 9900 });

    const after = (await admin.get(`/api/admin/appointments/${S.appt.id}`)).data.appointment.totals;
    const line = after.addons.find((a) => a.name === 'Pet hair removal');
    assert.equal(line.price_cents, 4000, 'the booked job keeps the price it was sold at');
    assert.equal(after.subtotal_cents, before.subtotal_cents, 'and the total does not budge');

    /* A new booking, though, gets the new price. */
    const fresh = await admin.post('/api/admin/appointments', {
      customer_id: S.customer.id, service_id: S.service.id, starts_at: Date.now() + 86400000,
      addon_ids: [petHair.id],
    });
    const freshLine = fresh.data.appointment.totals.addons[0];
    assert.equal(freshLine.price_cents, 9900, 'the new job uses the new price');

    await admin.patch(`/api/admin/catalog/addons/${petHair.id}`, { price_cents: 4000 });
    await admin.del(`/api/admin/appointments/${fresh.data.appointment.id}`);
  });

  test('an invoice that has gone out cannot be quietly rebuilt', async () => {
    const { status, data } = await admin.post(`/api/admin/appointments/${S.appt.id}/invoice`, {});
    assert.equal(status, 409);
    assert.match(data.error, /already been issued/);
  });

  test('a paid invoice cannot be voided out from under the payment', async () => {
    const { status, data } = await admin.post(`/api/admin/invoices/${S.invoice.id}/void`, {});
    assert.equal(status, 409);
    assert.match(data.error, /already been recorded/);
  });

  test('a customer with history is archived rather than deleted', async () => {
    const { status, data } = await admin.del(`/api/admin/customers/${S.customer.id}`);
    assert.equal(status, 200);
    assert.equal(data.archived, true);
    assert.ok(data.appointments > 0);
    /* The appointment and its invoice survive. */
    assert.equal((await admin.get(`/api/admin/appointments/${S.appt.id}`)).status, 200);
    await admin.patch(`/api/admin/customers/${S.customer.id}`, { archived: false });
  });
});
