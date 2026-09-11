/* Fills an empty database with a day that looks like a real one, so the
   dashboard can be looked at properly before any real customer exists.
   Refuses to touch a database that already has customers in it. */
import { init, close, q, getSetting } from '../src/db.js';
import { buildInvoice, issueInvoice, recordPayment, setTip } from '../src/billing.js';
import { createPortalLink } from '../src/links.js';

init();

if (q.pluck('SELECT COUNT(*) AS n FROM customers') > 0) {
  console.error('This database already has customers. Seeding would muddle real data.');
  close();
  process.exit(1);
}

const now = Date.now();
const TZ = getSetting('timezone') || 'UTC';

/* How far the business's timezone is from UTC at a given instant. */
function offsetAt(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value])
  );
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return asIfUtc - ms;
}

/* A wall-clock time in the business's own timezone, N days from today.
   Two passes so a clock change does not shift the appointment by an hour. */
const at = (dayOffset, hour, minute = 0) => {
  const day = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(now + dayOffset * 86400000)).map((p) => [p.type, p.value])
  );
  const wall = Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day), hour, minute);
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
};

const services = q.all('SELECT * FROM services ORDER BY sort_order');
const addons = Object.fromEntries(q.all('SELECT * FROM addons').map((a) => [a.name, a]));

const people = [
  { name: 'Dana Whitfield', phone: '+18105550134', email: 'dana@example.com', address: '412 Lakeshore Dr, Fenton, MI',
    lat: 42.7981, lng: -83.7049,
    vehicle: { year: '2019', make: 'Toyota', model: 'Tacoma', color: 'Silver' },
    service: 'Full Interior Detail', when: at(0, 9), extras: ['Pet hair removal'], status: 'confirmed',
    notes: 'Two retrievers ride in the back. Gate code on arrival.' },
  { name: 'Marcus Reed', phone: '+18105550188', email: 'marcus@example.com', address: '77 Orchard Ln, Linden, MI',
    lat: 42.8189, lng: -83.7830,
    vehicle: { year: '2022', make: 'Audi', model: 'Q5', color: 'Black' },
    service: 'Full Exterior Detail', when: at(0, 14), extras: ['Clay bar with long-lasting wax', 'Trim restoration'], status: 'scheduled' },
  { name: 'Priya Raman', phone: '+18105550102', email: 'priya@example.com', address: '1180 Elmwood Ct, Grand Blanc, MI',
    lat: 42.9275, lng: -83.6299,
    vehicle: { year: '2016', make: 'Honda', model: 'CR-V', color: 'Blue' },
    service: 'Express Wash & Dry', when: at(-1, 11), extras: ['Spray wax'], status: 'completed', paid: true },
  { name: 'Theo Alvarez', phone: '+18105550176', email: 'theo@example.com', address: '9 Fairway Dr, Holly, MI',
    lat: 42.7939, lng: -83.6255,
    vehicle: { year: '2021', make: 'Ford', model: 'Bronco', color: 'White' },
    service: 'Complete Inside & Out', when: at(1, 9, 30), extras: ['Headlight restoration'], status: 'scheduled' },
];

for (const person of people) {
  const customer = q.run(
    'INSERT INTO customers(name, phone, email, address, notes, sms_consent, created_at, updated_at) VALUES(?,?,?,?,?,1,?,?)',
    person.name, person.phone, person.email, person.address, person.notes ?? '', now, now
  );
  const vehicle = q.run(
    'INSERT INTO vehicles(customer_id, year, make, model, color, plate, notes, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    customer.id, person.vehicle.year, person.vehicle.make, person.vehicle.model, person.vehicle.color, '', '', now, now
  );

  const service = services.find((s) => s.name === person.service) ?? services[0];
  const appt = q.run(
    `INSERT INTO appointments(customer_id, vehicle_id, service_id, service_name, service_price_cents,
       starts_at, duration_min, address, lat, lng, status, notes, created_at, updated_at, completed_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    customer.id, vehicle.id, service.id, service.name, service.price_cents,
    person.when, service.duration_min, person.address, person.lat ?? null, person.lng ?? null,
    person.status, person.notes ?? '', now, now, person.status === 'completed' ? person.when : null
  );

  for (const name of person.extras ?? []) {
    const addon = addons[name];
    if (!addon) continue;
    q.run(
      `INSERT INTO appointment_addons(appointment_id, addon_id, name, description, price_cents, price_is_from, source, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      appt.id, addon.id, addon.name, addon.description, addon.price_cents, addon.price_is_from,
      name === 'Spray wax' ? 'customer' : 'admin', now
    );
  }

  createPortalLink(appt.id);

  if (person.paid) {
    const invoice = buildInvoice(appt.id, { actor: 'seed' });
    setTip(invoice.id, 800, { actor: 'seed' });
    const issued = issueInvoice(invoice.id, { actor: 'seed' });
    recordPayment(issued.id, {
      amountCents: issued.total_cents, tipCents: 800, method: 'card', actor: 'seed',
    });
    q.run(
      'INSERT INTO reviews(appointment_id, rating, comment, author_name, published, created_at) VALUES(?,?,?,?,1,?)',
      appt.id, 5, 'Spotless, and he texted when he set off so I knew exactly when to move the car.', 'Priya', now
    );
  }
}

console.log(`Seeded ${people.length} customers with vehicles, appointments and one finished job.`);
close();
