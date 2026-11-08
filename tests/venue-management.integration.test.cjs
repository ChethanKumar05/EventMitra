const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const url = process.env.VENUE_TEST_DATABASE_URL;

test('Owner-scoped venue configuration and admin venue management', {
  skip: !url && 'Set VENUE_TEST_DATABASE_URL to a fresh isolated *_test database',
}, async t => {
  assert.match(new URL(url).pathname, /_test$/);
  process.env.DATABASE_URL = url; process.env.NODE_ENV = 'test';
  const { pool } = require('../dist/config/database');
  const { runMigrations } = require('../dist/migrations/runMigrations');
  const { generateId } = require('../dist/utils/id');
  const { hashPassword } = require('../dist/security/password');
  let server;
  t.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await pool.end(); });
  assert.equal((await pool.query("SELECT to_regclass('public.venue_details') AS existing")).rows[0].existing, null);
  await runMigrations();
  const password = 'Venue-test-' + randomBytes(16).toString('hex'), hash = await hashPassword(password);
  const ownerA = generateId(), ownerB = generateId(), blockedOwner = generateId();
  for (const [id, phone, name, status] of [[ownerA, '9876400001', 'First Venue Owner', 'pending'], [ownerB, '9876400002', 'Second Venue Owner', 'verified'], [blockedOwner, '9876400003', 'Blocked Venue Owner', 'blocked']]) {
    await pool.query('INSERT INTO public.owner(owner_id,country_code,owner_phone_number,owner_name,email,password,status) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, '+91', phone, name, phone + '@example.test', hash, status]);
  }
  await require('../dist/services/adminAuthService').bootstrapSuperAdmin({ name: 'Venue test admin', email: 'venue-admin@example.test', password });
  const { app } = require('../dist/app'); server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = 'GET', body, cookie, extra = {}) {
    const response = await fetch(origin + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { ...await response.json(), status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  const adminLogin = await request('/api/admin/auth/login', 'POST', { email: 'venue-admin@example.test', password }); assert.equal(adminLogin.status, 200);
  const ownerLoginA = await request('/api/owner/auth/login', 'POST', { email: '9876400001@example.test', password }); assert.equal(ownerLoginA.status, 200);
  const ownerLoginB = await request('/api/owner/auth/login', 'POST', { email: '9876400002@example.test', password }); assert.equal(ownerLoginB.status, 200);
  const admin = adminLogin.cookie, cookieA = ownerLoginA.cookie, cookieB = ownerLoginB.cookie;
  const own = (path = '', method = 'GET', body, cookie = cookieA) => request('/api/owner/venues' + path, method, body, cookie);
  const manage = (path = '', method = 'GET', body, cookie = admin) => request('/api/admin/venues' + path, method, body, cookie);
  const adminApi = (path, method = 'GET', body) => request('/api/admin/' + path, method, body, admin);
  const sample = { venue_name: 'Garden %_ Hall', venue_hall_capacity: 250, venue_dining_capacity: 100, venue_available_rooms_count: 4, venue_images: ['/uploads/hall.jpg'], venue_documents: ['/uploads/private-proof.pdf'], pin_code: '560001', state: 'Karnataka', city: 'Bengaluru', area: 'Central', lat: 0, long: 0, venue_number: '+919876400001', venue_alternative_number: null, venue_website_url: 'https://example.test/hall', email: 'HALL@EXAMPLE.TEST', venue_parking_capacity: 20, venue_length: '100.50', venue_width: 50, venue_height: 10, refund_policy: ['Refund terms'], cancellation_policy: ['Cancellation terms'], description: 'Sample venue', is_active: true, is_cancellation_availble: true, venue_year_established: 2020 };
  let venueA, venueB, slotA, slotB, decorationA, decorationB, mealA, mealB, priceA;
  const dropdownParts = ['type-slots', 'decorations', 'meals'];

  await t.test('Creation, strict validation, owner scope and private detail response', async () => {
    assert.equal((await request('/api/owner/venues')).status, 401);
    assert.equal((await request('/api/admin/venues')).status, 401);
    assert.equal((await own('', 'POST', sample, admin)).status, 401);
    assert.equal((await manage('', 'POST', { ...sample, owner_id: ownerA }, cookieA)).status, 401);
    for (const body of [null, [], {}, { ...sample, venue_name: '' }, { ...sample, venue_code: 'VEN00001' }, { ...sample, owner_id: ownerB }, { ...sample, status: 'Active' }, { ...sample, reason: 'Forged approval' }, { ...sample, venue_hall_capacity: -1 }, { ...sample, venue_hall_capacity: '5' }, { ...sample, venue_images: 'not-array' }, { ...sample, lat: 91 }, { ...sample, long: '0' }, { ...sample, email: 'bad' }, { ...sample, venue_number: 123 }, { ...sample, venue_website_url: 'javascript:alert(1)' }, { ...sample, venue_width: '1.005' }, { ...sample, venue_year_established: 1799 }, { ...sample, is_active: 'true' }]) assert.equal((await own('', 'POST', body)).status, 400, JSON.stringify(body));
    const created = await own('', 'POST', sample); assert.equal(created.status, 201, created.message);
    venueA = created.data.venue_id; assert.equal(created.data.venue_code, 'VEN00001'); assert.equal(created.data.owner_id, ownerA); assert.equal(created.data.status, 'Pending'); assert.equal(created.data.email, 'hall@example.test'); assert.equal(created.headers.get('cache-control'), 'no-store');
    const other = await own('', 'POST', { venue_name: 'Other Owner Venue', city: 'Chennai' }, cookieB); assert.equal(other.status, 201); venueB = other.data.venue_id;
    const detail = await own('/' + venueA); assert.equal(detail.status, 200);
    for (const key of ['venue_type_slots', 'venue_price_details', 'venue_decoration_details', 'venue_meals_details']) assert.deepEqual(detail.data[key], []);
    assert.equal(detail.data.venue_aminites, null); assert.deepEqual(detail.data.venue_documents, sample.venue_documents);
    for (const part of dropdownParts) {
      const empty = await own(`/${venueA}/${part}/dropdown`); assert.equal(empty.status, 200); assert.deepEqual(empty.data, []);
      assert.equal((await request(`/api/owner/venues/${venueA}/${part}/dropdown`)).status, 401);
      assert.equal((await request(`/api/admin/venues/${venueA}/${part}/dropdown`)).status, 401);
      assert.equal((await own(`/${venueB}/${part}/dropdown`)).status, 404, 'Dropdown is scoped to the logged-in owner');
      assert.equal((await manage(`/${venueB}/${part}/dropdown`)).status, 200, 'Admin can read another assigned owner venue');
      assert.equal((await manage(`/missing/${part}/dropdown`)).status, 404);
      assert.equal((await own(`/${'x'.repeat(27)}/${part}/dropdown`)).status, 400);
      assert.equal((await own(`/${venueA}/${part}/dropdown?venue_id=${venueB}`)).status, 400, 'Query cannot override venue scope');
    }
    assert.equal((await own('/' + venueB)).status, 404); assert.equal((await own('/' + venueB, 'PUT', { venue_name: 'Stolen' })).status, 404);
    assert.equal((await own('?owner_id=' + ownerB)).status, 400);
    assert.equal((await own()).data.total, 1); assert.equal((await own('', 'GET', undefined, cookieB)).data.total, 1);
    assert.equal((await own('/' + venueA, 'PUT', { owner_id: ownerB })).status, 400);
    assert.equal((await own('/' + venueA, 'PUT', {})).status, 400);
    assert.equal((await own('/' + venueA, 'PUT', { venue_hall_capacity: 300, description: null })).status, 200);
    assert.equal((await request('/api/venues/' + venueA)).status, 404, 'Pending venue is private');
    assert.equal((await manage('', 'POST', sample)).status, 400, 'Admin must select owner');
    assert.equal((await manage('', 'POST', { venue_name: 'Blocked owner test', owner_id: blockedOwner })).status, 409);
    const byAdmin = await manage('', 'POST', { venue_name: 'Admin-created venue', owner_id: ownerA, status: 'Active' }); assert.equal(byAdmin.status, 201);
    assert.equal((await own()).data.total, 2);
    assert.equal((await manage('/' + venueA)).status, 200);
    assert.equal((await manage('/' + venueA, 'PUT', { owner_id: ownerB })).status, 400, 'Ownership cannot be transferred');
    const filtered = await own('?page=1&limit=1&search_column=venue_name&search=%25_&city=bengaluru&min_capacity=300&max_capacity=300&sort_by=venue_name&sort_order=asc');
    assert.equal(filtered.status, 200); assert.equal(filtered.data.total, 1); assert.equal(filtered.data.items[0].venue_id, venueA);
    const owners = await manage('/owners?search_column=owner_name&search=FIRST&limit=1'); assert.equal(owners.status, 200); assert.equal(owners.data.items[0].owner_id, ownerA); assert.equal(owners.data.items[0].password, undefined);
    const list = await manage('?owner_id=' + ownerA + '&limit=1'); assert.equal(list.data.total, 2); assert.equal(list.data.hasNextPage, true); assert.equal(list.data.items[0].owner_name, 'First Venue Owner');
    assert.equal((await manage('?owner_id=' + ownerB)).data.total, 1);
    assert.equal((await own('?search=' + encodeURIComponent("' OR 1=1 --"))).data.total, 0);
    assert.equal((await own('?page=999')).data.items.length, 0);
    for (const query of ['page=0', 'limit=101', 'search=x&search=y', 'status=active', 'sort_by=password', 'search_column=venue_documents', 'min_capacity=-1', 'min_capacity=10&max_capacity=9', 'max_capacity=1.5', 'is_active=yes', 'unknown=x']) assert.equal((await manage('?' + query)).status, 400, query);
  });

  await t.test('Slots, singleton amenities, decorations, meals and linked pricing', async () => {
    const slot = await own(`/${venueA}/type-slots`, 'POST', { slot_name: 'Morning', from_time: '08:00', to_time: '16:00', is_active: true }); assert.equal(slot.status, 201); slotA = slot.data.venue_type_slot_id;
    const second = await own(`/${venueA}/type-slots`, 'POST', { slot_name: 'Night', from_time: '18:00', to_time: '06:00' }); assert.equal(second.status, 201); slotB = second.data.venue_type_slot_id;
    assert.equal((await own(`/${venueB}/type-slots`, 'POST', { slot_name: 'Foreign', from_time: '08:00', to_time: '16:00' })).status, 404);
    for (const body of [{}, { slot_name: 'Missing times' }, { slot_name: 'Equal', from_time: '08:00', to_time: '08:00:00' }, { slot_name: 'Invalid', from_time: '25:00', to_time: '16:00' }, { slot_name: 'Forged', from_time: '08:00', to_time: '16:00', venue_id: venueB }]) assert.equal((await own(`/${venueA}/type-slots`, 'POST', body)).status, 400);
    assert.equal((await own(`/${venueA}/type-slots`, 'POST', { venue_type_slot_id: slotA, description: 'Updated slot' })).status, 200);
    assert.equal((await own(`/${venueA}/type-slots`, 'POST', { venue_type_slot_id: slotA, to_time: '08:00' })).status, 400);
    assert.equal((await own(`/${venueB}/type-slots`, 'POST', { venue_type_slot_id: slotA, slot_name: 'Stolen' }, cookieB)).status, 404);
    assert.equal((await own(`/${venueA}/type-slots`, 'POST', { venue_type_slot_id: 'missing', slot_name: 'Missing' })).status, 404);
    const amenity = await own(`/${venueA}/amenities`, 'PUT', { is_ac_available: true }); assert.equal(amenity.status, 201);
    assert.equal((await own(`/${venueA}/amenities`, 'PUT', { is_chairs_available: true })).status, 200);
    assert.equal((await own(`/${venueA}/amenities`, 'PUT', { is_ac_available: 'true' })).status, 400);
    assert.equal((await own(`/${venueA}/amenities`, 'PUT', {})).status, 400);
    const decoration = await own(`/${venueA}/decorations`, 'POST', { venue_decoration_name: 'Flowers', venue_decoration_price: '1000.50', venue_decoration_advance_price: '100', venue_decoration_images: ['/flowers.jpg'], cancelation_policy: ['Terms'], advance_return_within_date: '2027-01-01' });
    assert.equal(decoration.status, 201); decorationA = decoration.data.venue_decoration_id; assert.equal(decoration.data.venue_decoration_code, 'DEC00001'); assert.equal(decoration.data.advance_return_within_date, '2027-01-01');
    decorationB = (await own(`/${venueA}/decorations`, 'POST', { venue_decoration_name: 'Lights' })).data.venue_decoration_id;
    assert.equal((await own(`/${venueA}/decorations`, 'POST', { venue_decoration_id: decorationA, venue_decoration_price: 50 })).status, 400, 'Compare partial update with saved advance');
    assert.equal((await own(`/${venueA}/decorations`, 'POST', { venue_decoration_name: 'Invalid', venue_decoration_price: 1.005 })).status, 400);
    assert.equal((await own(`/${venueA}/decorations`, 'POST', { venue_decoration_id: decorationB, venue_decoration_price: '10.25' })).status, 200);
    const veg = await own(`/${venueA}/meals`, 'POST', { is_veg: true, meal_deatails: ['Rice', 'Curry'], per_plate_price: '250.50', meals_advance_price: '1000' }); assert.equal(veg.status, 201); mealA = veg.data.venue_meals_id;
    const nonVeg = await own(`/${venueA}/meals`, 'POST', { is_non_veg: true, per_plate_price: 400 }); assert.equal(nonVeg.status, 201); mealB = nonVeg.data.venue_meals_id;
    assert.equal((await own(`/${venueA}/meals`, 'POST', { is_veg: true })).status, 409);
    assert.equal((await own(`/${venueA}/meals`, 'POST', { venue_meals_id: mealA, per_plate_price: 300 })).status, 200);
    assert.equal((await own(`/${venueA}/meals`, 'POST', { venue_meals_id: mealA, advance_return_within_date: '2027-02-30' })).status, 400);
    const priceBody = { venue_type_slot_id: slotA, venue_from_date: '2027-01-01', venue_to_date: '2027-12-31', venue_from_time: '08:00', venue_to_time: '16:00', venue_price: '5000.50', venue_advance_price: '500', venue_decoration_id: decorationA, venue_meals_id: mealA };
    const price = await own(`/${venueA}/prices`, 'POST', priceBody); assert.equal(price.status, 201, price.message); priceA = price.data.venue_price_id; assert.equal(price.data.venue_type_slot_id, slotA); assert.equal(price.data.venue_from_date, '2027-01-01');
    assert.equal((await own(`/${venueA}/prices`, 'POST', { ...priceBody, venue_type_slot_id: slotB, venue_from_time: '18:00', venue_to_time: '06:00' })).status, 201, 'More than one price record allowed');
    for (const patch of [{ venue_type_slot_id: null }, { venue_to_date: '2026-12-31' }, { venue_price: 100 }, { venue_to_time: '08:00' }, { venue_decoration_from_date: '2027-01-01' }]) assert.equal((await own(`/${venueA}/prices`, 'POST', { venue_price_id: priceA, ...patch })).status, 400, JSON.stringify(patch));
    const foreignSlot = (await own(`/${venueB}/type-slots`, 'POST', { slot_name: 'Foreign', from_time: '08:00', to_time: '16:00' }, cookieB)).data.venue_type_slot_id;
    const foreignDecoration = (await own(`/${venueB}/decorations`, 'POST', { venue_decoration_name: 'Other venue flowers' }, cookieB)).data.venue_decoration_id;
    const foreignMeal = (await own(`/${venueB}/meals`, 'POST', { is_veg: true }, cookieB)).data.venue_meals_id;
    for (const patch of [{ venue_type_slot_id: foreignSlot }, { venue_decoration_id: foreignDecoration }, { venue_meals_id: foreignMeal }]) assert.equal((await own(`/${venueA}/prices`, 'POST', { ...priceBody, ...patch })).status, 409);
    assert.equal((await manage(`/${venueB}/prices`, 'POST', { venue_price_id: priceA, venue_price: 9000 })).status, 404);
    assert.equal((await own(`/${venueA}/prices`, 'POST', { venue_price_id: priceA, venue_decoration_from_date: '2027-01-01', venue_decoration_to_date: '2027-01-02', venue_decoration_from_time: '08:00', venue_decoration_to_time: '16:00' })).status, 200);
    const cleared = await own(`/${venueA}/prices`, 'POST', { venue_price_id: priceA, venue_decoration_id: null }); assert.equal(cleared.status, 200); assert.equal(cleared.data.venue_decoration_from_date, null);
    const full = await own('/' + venueA); assert.equal(full.data.venue_type_slots.length, 2); assert.equal(full.data.venue_decoration_details.length, 2); assert.equal(full.data.venue_meals_details.length, 2); assert.equal(full.data.venue_price_details.length, 2); assert.equal(full.data.venue_aminites.is_ac_available, true); assert.equal(full.data.venue_aminites.is_chairs_available, true);
    await assert.rejects(pool.query('UPDATE public.venue_price_details SET venue_type_slot_id=$1 WHERE venue_price_id=$2', [foreignSlot, priceA]), error => error.code === '23503');
    await assert.rejects(pool.query('UPDATE public.venue_meals_details SET venue_id=$1 WHERE venue_meals_id=$2', [venueB, mealA]), error => error.code === '23514' && error.constraint === 'venue_meal_owner_immutable');
    assert.equal((await manage(`/${venueA}/type-slots/${slotA}`, 'DELETE')).status, 409, 'Referenced slot cannot be removed');
    assert.equal((await manage(`/${venueA}/meals/${mealA}`, 'DELETE')).status, 409, 'Referenced meal cannot be removed');
  });

  await t.test('Price dropdowns return compact, deterministic options from this venue only', async () => {
    const slots = await own(`/${venueA}/type-slots/dropdown`); assert.equal(slots.status, 200);
    assert.deepEqual(slots.data.map(row => row.value), [slotA, slotB]);
    assert.equal(slots.data[0].venue_type_slot_id, slotA); assert.equal(slots.data[0].label, 'Morning');
    assert.equal(slots.data[0].from_time, '08:00:00'); assert.equal(slots.data[0].to_time, '16:00:00'); assert.equal(slots.data[0].is_active, true);
    const decorations = await own(`/${venueA}/decorations/dropdown`); assert.equal(decorations.status, 200);
    assert.deepEqual(new Set(decorations.data.map(row => row.value)), new Set([decorationA, decorationB]));
    const flowers = decorations.data.find(row => row.value === decorationA);
    assert.equal(flowers.venue_decoration_id, decorationA); assert.equal(flowers.label, 'Flowers'); assert.equal(flowers.venue_decoration_code, 'DEC00001'); assert.equal(flowers.venue_decoration_price, 1000.5);
    const meals = await own(`/${venueA}/meals/dropdown`); assert.equal(meals.status, 200);
    assert.deepEqual(new Set(meals.data.map(row => row.value)), new Set([mealA, mealB]));
    const veg = meals.data.find(row => row.value === mealA), nonVeg = meals.data.find(row => row.value === mealB);
    assert.equal(veg.venue_meals_id, mealA); assert.equal(veg.label, 'Vegetarian'); assert.equal(veg.is_veg, true); assert.equal(veg.per_plate_price, 300); assert.deepEqual(veg.meal_deatails, ['Rice', 'Curry']);
    assert.equal(nonVeg.label, 'Non-vegetarian'); assert.equal(nonVeg.is_non_veg, true);
    for (const part of dropdownParts) {
      const ownerResult = await own(`/${venueA}/${part}/dropdown`), adminResult = await manage(`/${venueA}/${part}/dropdown`);
      assert.deepEqual(adminResult.data, ownerResult.data);
      for (const row of ownerResult.data) { assert.equal(row.venue_documents, undefined); assert.equal(row.owner_id, undefined); assert.equal(row.password, undefined); }
    }
    await own(`/${venueA}/type-slots`, 'POST', { venue_type_slot_id: slotB, is_active: false });
    assert.equal((await own(`/${venueA}/type-slots/dropdown`)).data.find(row => row.value === slotB).is_active, false, 'Inactive slots remain identifiable for existing price selection');
    await own(`/${venueA}/type-slots`, 'POST', { venue_type_slot_id: slotB, is_active: true });
  });

  await t.test('Single POST creates without an ID and updates the selected existing record', async () => {
    const detail = (await own('/' + venueA)).data;
    const cases = [
      ['type-slots', 'venue_type_slots', 'venue_type_slot_id', slotA, { slot_name: 'Saved through POST' }],
      ['decorations', 'venue_decoration_details', 'venue_decoration_id', decorationA, { venue_decoration_name: 'Saved flowers' }],
      ['meals', 'venue_meals_details', 'venue_meals_id', mealA, { per_plate_price: 350 }],
      ['prices', 'venue_price_details', 'venue_price_id', priceA, { venue_price: '6000.00' }],
    ];
    for (const [path, table, idField, id, patch] of cases) {
      assert.ok(detail[table].some(row => row[idField] === id), 'Frontend receives ' + idField + ' from detail');
      const saved = await own(`/${venueA}/${path}`, 'POST', { [idField]: id, ...patch });
      assert.equal(saved.status, 200, saved.message); assert.equal(saved.message, 'Venue record updated'); assert.equal(saved.data[idField], id);
      for (const [key, value] of Object.entries(patch)) assert.equal(saved.data[key], typeof saved.data[key] === 'number' ? Number(value) : value);
      assert.equal((await own(`/${venueA}/${path}`, 'POST', { [idField]: 'missing', ...patch })).status, 404, 'Unknown ID never inserts');
      assert.equal((await own(`/${venueB}/${path}`, 'POST', { [idField]: id, ...patch }, cookieB)).status, 404, 'Other-venue ID never inserts or updates');
      assert.equal((await manage(`/${venueB}/${path}`, 'POST', { [idField]: id, ...patch })).status, 404);
      assert.equal((await own(`/${venueA}/${path}`, 'POST', { [idField]: id })).status, 400, 'ID alone is not an update');
      for (const invalid of ['', '   ', 123, 'x'.repeat(27)]) assert.equal((await own(`/${venueA}/${path}`, 'POST', { [idField]: invalid, ...patch })).status, 400, 'Invalid ID does not fall back to insert');
      assert.equal((await own('/' + venueA)).data[table].length, detail[table].length);
    }
    const simultaneous = await Promise.all([350, 360].map(per_plate_price => own(`/${venueA}/meals`, 'POST', { venue_meals_id: mealA, per_plate_price })));
    assert.deepEqual(simultaneous.map(row => row.status), [200, 200]);
    assert.equal((await own('/' + venueA)).data.venue_meals_details.length, 2, 'Updating at the two-meal limit does not insert a third row');
    const created = await own(`/${venueA}/decorations`, 'POST', { venue_decoration_name: 'Additional new record' });
    assert.equal(created.status, 201); assert.equal(created.message, 'Venue record created'); assert.notEqual(created.data.venue_decoration_id, decorationA);
  });

  await t.test('Null IDs create and populated IDs update on the same endpoint for owners and admins', async () => {
    for (const isAdmin of [false, true]) {
      const save = isAdmin ? manage : own;
      const parent = await save('', 'POST', { venue_name: 'Null ID venue', ...(isAdmin ? { owner_id: ownerA } : {}) });
      assert.equal(parent.status, 201);
      const venueId = parent.data.venue_id, ids = {};
      const cases = [
        ['type-slots', 'venue_type_slots', 'venue_type_slot_id', { slot_name: 'Evening', from_time: '18:00', to_time: '06:00', description: 'Overnight events', is_active: true }, { slot_name: 'Morning', from_time: '08:00', to_time: '16:00', description: 'Morning events', is_active: true }],
        ['decorations', 'venue_decoration_details', 'venue_decoration_id', { venue_decoration_name: 'Evening flowers', venue_decoration_price: '1000.00' }, { venue_decoration_name: 'Morning flowers' }],
        ['meals', 'venue_meals_details', 'venue_meals_id', { is_veg: true, per_plate_price: '200.00' }, { per_plate_price: '250.00' }],
        ['prices', 'venue_price_details', 'venue_price_id', { venue_from_date: '2027-01-01', venue_to_date: '2027-12-31', venue_from_time: '08:00', venue_to_time: '16:00', venue_price: '5000.00' }, { venue_price: '6000.00' }],
      ];
      for (const [path, table, idField, body, patch] of cases) {
        const created = await save(`/${venueId}/${path}`, 'POST', { [idField]: null, ...body, ...(path === 'prices' ? { venue_type_slot_id: ids['type-slots'] } : {}) });
        assert.equal(created.status, 201, created.message); assert.equal(created.message, 'Venue record created'); assert.equal(typeof created.data[idField], 'string');
        ids[path] = created.data[idField];
        const updated = await save(`/${venueId}/${path}`, 'POST', { [idField]: ids[path], ...patch });
        assert.equal(updated.status, 200); assert.equal(updated.message, 'Venue record updated'); assert.equal(updated.data[idField], ids[path]);
        assert.equal((await own('/' + venueId)).data[table].length, 1, 'Updating does not insert another row');
        assert.equal((await save(`/${venueId}/${path}/${ids[path]}`, 'PUT', patch)).status, 404, 'Separate child PUT API is removed');
        assert.equal((await save(`/${venueId}/${path}`, 'POST', { [idField]: null })).status, 400, 'Null ID still requires creation fields');
      }
    }
  });

  await t.test('Concurrent meal cap, singleton updates and approval handling', async () => {
    const fresh = (await own('', 'POST', { venue_name: 'Concurrent meals' })).data.venue_id;
    const results = await Promise.all([own(`/${fresh}/meals`, 'POST', { is_veg: true }), own(`/${fresh}/meals`, 'POST', { is_non_veg: true }), manage(`/${fresh}/meals`, 'POST', { is_veg: true })]);
    assert.deepEqual(results.map(row => row.status).sort(), [201, 201, 409]);
    const sqlVenue = (await own('', 'POST', { venue_name: 'SQL meal guard' }, cookieB)).data.venue_id;
    const sqlResults = await Promise.allSettled([1, 2, 3].map(() => pool.query('INSERT INTO public.venue_meals_details(venue_id,venue_meals_id) VALUES($1,$2)', [sqlVenue, generateId()])));
    assert.equal(sqlResults.filter(row => row.status === 'fulfilled').length, 2); assert.equal(sqlResults.find(row => row.status === 'rejected').reason.constraint, 'venue_meal_limit');
    const amenities = await Promise.all([own(`/${fresh}/amenities`, 'PUT', { is_ac_available: true }), own(`/${fresh}/amenities`, 'PUT', { is_fan_available: true })]);
    assert.deepEqual(amenities.map(row => row.status).sort(), [200, 201]);
    const combined = (await own('/' + fresh)).data.venue_aminites; assert.equal(combined.is_ac_available, true); assert.equal(combined.is_fan_available, true);
    assert.equal((await manage('/' + venueA, 'PUT', { status: 'Active' })).status, 200);
    const publicRecord = await request('/api/venues/' + venueA); assert.equal(publicRecord.status, 200); assert.equal(publicRecord.data.venue_documents, undefined); assert.equal(publicRecord.data.venue_price_details, undefined);
    assert.equal((await own(`/${venueA}/type-slots`, 'POST', { venue_type_slot_id: slotA, description: 'Changed after approval' })).status, 200);
    assert.equal((await own('/' + venueA)).data.status, 'Pending'); assert.equal((await request('/api/venues/' + venueA)).status, 404);
    await manage('/' + venueA, 'PUT', { status: 'Active' }); await own('/' + venueA, 'PUT', { venue_name: 'Owner edit' }); assert.equal((await own('/' + venueA)).data.status, 'Pending');
    await manage('/' + venueA, 'PUT', { status: 'Blocked' }); assert.equal((await own('/' + venueA, 'PUT', { venue_name: 'Bypass block' })).status, 403); assert.equal((await own(`/${venueA}/amenities`, 'PUT', { is_ac_available: false })).status, 403);
    await manage('/' + venueA, 'PUT', { status: 'Pending' });
    await assert.rejects(require('../dist/services/venueManagementService').updateManagedVenue({ type: 'owner', ownerId: ownerA, token: 'a'.repeat(64) }, venueA, { venue_name: 'Invalid session' }), /authentication required/);
    assert.equal((await request('/api/owner/venues/' + venueA, 'PUT', { venue_name: 'Bad origin' }, cookieA, { origin: 'https://evil.example' })).status, 403);
  });

  await t.test('Admin module permissions, dropdown access and live grant revocation', async () => {
    const roleId = (await adminApi('roles', 'POST', { role_type: 'Venue Operator' })).data.role_id;
    const adminId = (await adminApi('admins', 'POST', { admin_name: 'Venue Operator', admin_username: 'venue_operator', admin_email: 'operator@example.test', password, role_id: roleId })).data.admin_id;
    const login = await request('/api/admin/auth/login', 'POST', { email: 'operator@example.test', password }), delegated = login.cookie;
    assert.equal((await manage('', 'GET', undefined, delegated)).status, 403); assert.equal((await manage('/owners', 'GET', undefined, delegated)).status, 403);
    for (const part of dropdownParts) assert.equal((await manage(`/${venueA}/${part}/dropdown`, 'GET', undefined, delegated)).status, 403);
    const moduleId = (await adminApi('modules', 'POST', { module_name: 'Venue Management', module_key: 'venue_management' })).data.module_id;
    const grant = flags => adminApi('admin-permissions', 'POST', { admin_id: adminId, role_id: roleId, module_id: moduleId, ...flags });
    assert.equal((await grant({ view: true })).status, 200);
    assert.equal((await manage('', 'GET', undefined, delegated)).status, 200); assert.equal((await manage('/' + venueA, 'GET', undefined, delegated)).status, 200); assert.equal((await manage('/owners?search=first', 'GET', undefined, delegated)).data.total, 1);
    for (const part of dropdownParts) assert.equal((await manage(`/${venueA}/${part}/dropdown`, 'GET', undefined, delegated)).status, 200, 'View permission authorizes price dropdowns');
    assert.equal((await request('/api/admin/owners', 'GET', undefined, delegated)).status, 403, 'Venue owner dropdown does not grant owner-management access');
    assert.equal((await manage('', 'POST', { venue_name: 'Denied', owner_id: ownerA }, delegated)).status, 403);
    assert.equal((await manage('/' + venueA, 'PUT', { status: 'Active' }, delegated)).status, 403); assert.equal((await manage('/' + venueA, 'DELETE', undefined, delegated)).status, 403);
    assert.equal((await manage(`/${venueA}/type-slots`, 'POST', { slot_name: 'Denied', from_time: '08:00', to_time: '16:00' }, delegated)).status, 403);
    await grant({ create: true });
    const delegatedCreate = await manage('', 'POST', { venue_name: 'Delegated create', owner_id: ownerA }, delegated);
    assert.equal(delegatedCreate.status, 201);
    const delegatedVenue = delegatedCreate.data.venue_id;
    assert.equal((await manage(`/${venueA}/amenities`, 'PUT', { is_ac_available: true }, delegated)).status, 403);
    const nullInserts = [
      ['type-slots', { venue_type_slot_id: null, slot_name: 'Create-only null slot', from_time: '08:00', to_time: '16:00' }],
      ['decorations', { venue_decoration_id: null, venue_decoration_name: 'Create-only null decoration' }],
      ['meals', { venue_meals_id: null, is_veg: true }],
      ['prices', { venue_price_id: null, venue_from_date: '2027-01-01', venue_to_date: '2027-12-31', venue_from_time: '08:00', venue_to_time: '16:00', venue_price: '5000.00' }],
    ];
    let delegatedSlot;
    for (const [path, body] of nullInserts) {
      if (path === 'prices') body.venue_type_slot_id = delegatedSlot;
      const created = await manage(`/${delegatedVenue}/${path}`, 'POST', body, delegated);
      assert.equal(created.status, 201, 'Create-only admin can insert a null ID: ' + created.message);
      if (path === 'type-slots') delegatedSlot = created.data.venue_type_slot_id;
    }
    const updates = [
      ['type-slots', { venue_type_slot_id: slotA, description: 'Admin POST edit' }],
      ['decorations', { venue_decoration_id: decorationA, venue_decoration_name: 'Admin POST flowers' }],
      ['meals', { venue_meals_id: mealA, per_plate_price: 400 }],
      ['prices', { venue_price_id: priceA, venue_price: '6500.00' }],
    ];
    for (const [path, body] of updates) assert.equal((await manage(`/${venueA}/${path}`, 'POST', body, delegated)).status, 403, 'Create permission cannot update through POST');
    await grant({ edit: true, create: false });
    for (const [path, body] of nullInserts) assert.equal((await manage(`/${delegatedVenue}/${path}`, 'POST', body, delegated)).status, 403, 'Edit-only admin cannot insert a null ID');
    for (const [path, body] of updates) assert.equal((await manage(`/${venueA}/${path}`, 'POST', body, delegated)).status, 200, 'Edit-only permission can update through POST');
    assert.equal((await manage(`/${venueA}/type-slots`, 'POST', { slot_name: 'Denied insert', from_time: '08:00', to_time: '16:00' }, delegated)).status, 403, 'Edit permission cannot create through POST');
    assert.equal((await manage('/' + venueA, 'PUT', { status: 'Active' }, delegated)).status, 200); assert.equal((await manage(`/${venueA}/amenities`, 'PUT', { is_ac_available: true }, delegated)).status, 200);
    await grant({ view: false, read: false, edit: false, create: false }); assert.equal((await manage('', 'GET', undefined, delegated)).status, 403);
    for (const part of dropdownParts) assert.equal((await manage(`/${venueA}/${part}/dropdown`, 'GET', undefined, delegated)).status, 403, 'Revoked grants immediately deny dropdown access');
    await assert.rejects(require('../dist/services/venueManagementService').updateManagedVenue({ type: 'admin', actor: { adminId, sessionToken: delegated.split('=')[1] } }, venueA, { venue_name: 'Stale permission' }), /Permission denied/);
  });

  await t.test('Admin deletion preserves venue history and child deletion respects references', async () => {
    const userId = generateId(), bookingId = generateId();
    await pool.query('INSERT INTO public."user"(user_id,country_code,user_phone_number,user_name) VALUES($1,$2,$3,$4)', [userId, '+91', '9876400099', 'Booking fixture']);
    await pool.query("INSERT INTO public.booking(booking_id,user_id,venue_id,booking_from,booking_to) VALUES($1,$2,$3,'2027-01-01T08:00:00Z','2027-01-01T16:00:00Z')", [bookingId, userId, venueA]);
    assert.equal((await manage('/' + venueA, 'DELETE')).status, 200);
    const deleted = await manage('/' + venueA); assert.equal(deleted.data.status, 'Deleted'); assert.equal(deleted.data.is_active, false); assert.equal(deleted.data.venue_price_details.length, 2);
    assert.equal((await manage('?status=Deleted&owner_id=' + ownerA)).data.total, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.booking WHERE booking_id=$1', [bookingId])).rows[0].n, 1);
    assert.equal((await own('/' + venueA)).status, 200, 'Owner can read retained configuration'); assert.equal((await own('/' + venueA, 'PUT', { venue_name: 'Restore' })).status, 403);
    assert.equal((await request('/api/venues/' + venueA)).status, 404);
    assert.equal((await manage(`/${venueA}/prices/${priceA}`, 'DELETE')).status, 200);
    assert.equal((await manage(`/${venueA}/type-slots/${slotA}`, 'DELETE')).status, 200);
    assert.equal((await manage(`/${venueA}/decorations/${decorationB}`, 'DELETE')).status, 200);
    assert.equal((await manage(`/${venueA}/meals/${mealB}`, 'DELETE')).status, 200);
    assert.equal((await manage(`/${venueA}/amenities`, 'DELETE')).status, 200); assert.equal((await manage('/' + venueA)).data.venue_aminites, null);
    assert.equal((await manage('/missing', 'DELETE')).status, 404);
  });
  await runMigrations();
});
