const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const url = process.env.PEOPLE_TEST_DATABASE_URL;

test('Admin people management and user/owner bank accounts', {
  skip: !url && 'Set PEOPLE_TEST_DATABASE_URL to a fresh isolated *_test database',
}, async t => {
  assert.match(new URL(url).pathname, /_test$/);
  process.env.DATABASE_URL = url; process.env.NODE_ENV = 'test';
  const { pool } = require('../dist/config/database');
  const { runMigrations } = require('../dist/migrations/runMigrations');
  const { generateId } = require('../dist/utils/id');
  const { verifyPassword } = require('../dist/security/password');
  let server;
  t.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await pool.end(); });
  assert.equal((await pool.query("SELECT to_regclass('public.admin') AS existing")).rows[0].existing, null);
  await runMigrations();
  const password = 'Management-test-' + randomBytes(16).toString('hex');
  await require('../dist/services/adminAuthService').bootstrapSuperAdmin({ name: 'People test admin', email: 'super@example.test', password });
  const { app } = require('../dist/app'); server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = 'GET', body, cookie, headers = {}) {
    const response = await fetch(origin + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { ...await response.json(), status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  const superLogin = await request('/api/admin/auth/login', 'POST', { email: 'super@example.test', password });
  assert.equal(superLogin.status, 200, 'New admin routes must not intercept auth/login');
  const admin = superLogin.cookie;
  const manage = (path, method = 'GET', body, cookie = admin) => request('/api/admin/' + path, method, body, cookie);
  const bankBody = number => ({ account_number: number, account_holder_name: 'Test Account Holder', ifsc_code: 'sbin0001234', branch_name: 'Central', branch_address: 'Test branch address', passbook_image: '/uploads/passbook.jpg' });
  const userBody = number => ({ country_code: '+91', user_phone_number: number, user_name: 'Test User %_ Name', gender: 'm', email: `${number}@example.test` });
  const ownerBody = number => ({ country_code: '+91', owner_phone_number: number, owner_name: 'Owner ' + number, email: `${number}@example.test`, password, gender: 'f', doc_type: 'passport', doc_number: 'TEST-DOCUMENT', doc_image: '/uploads/doc.jpg', pin_code: '560001', state: 'Karnataka', city: 'Bengaluru', area: 'Central', lat: 0, long: 0, address: 'Test address' });
  const people = {};

  await t.test('Admin CRUD, validation, safe responses and filtered pagination', async () => {
    for (const kind of ['user', 'owner']) {
      const resource = kind + 's', body = kind === 'user' ? userBody('9876500001') : ownerBody('9876600001');
      assert.equal((await request('/api/admin/' + resource)).status, 401);
      assert.equal((await manage(resource, 'POST', {})).status, 400);
      for (const patch of [{ status: 'invalid' }, { [`${kind}_code`]: 'forged' }, { is_phone_number_verified: true }, { gender: 'x' }, { email: 'invalid' }, { reason: {} }]) assert.equal((await manage(resource, 'POST', { ...body, ...patch })).status, 400);
      const created = await manage(resource, 'POST', body);
      assert.equal(created.status, 201, created.message);
      assert.match(created.data[`${kind}_code`], kind === 'user' ? /^USR[0-9]{5,}$/ : /^OWN[0-9]{5,}$/);
      assert.equal(created.data.password, undefined); assert.equal(created.data.password_hash, undefined);
      const id = created.data[`${kind}_id`];
      assert.equal((await manage(resource + '/' + id)).data[`${kind}_id`], id);
      assert.equal((await manage(resource + '/missing')).status, 404);
      assert.equal((await manage(resource, 'POST', body)).status, 409);
      if (kind === 'owner') {
        const stored = (await pool.query('SELECT password FROM public.owner WHERE owner_id=$1', [id])).rows[0].password;
        assert.notEqual(stored, password); assert.equal(await verifyPassword(password, stored), true);
        assert.equal((await manage(resource, 'POST', { ...body, owner_phone_number: '9876600099', email: 'unique@example.test', owner_name: '  OWNER   9876600001  ' })).status, 409);
      }
      const otherBody = kind === 'user' ? userBody('9876500002') : ownerBody('9876600002');
      const other = await manage(resource, 'POST', otherBody); assert.equal(other.status, 201);
      const profilePath = resource + '/' + id;
      for (const patch of [{}, { country_code: '91' }, { [`${kind}_phone_number`]: 9876500001 }, { email: 'bad' }, { unknown: true }, { [kind === 'owner' ? 'kyc_verification' : 'is_active']: 'true' }]) assert.equal((await manage(profilePath, 'PUT', patch)).status, 400);
      assert.equal((await manage(profilePath, 'PUT', { reason: 'Reviewed', status: 'verified' })).status, 200);
      assert.equal((await manage(profilePath, 'PUT', { email: otherBody.email })).status, 409);
      const list = await manage(resource + '?page=1&limit=1&search_column=' + kind + '_name&search=' + encodeURIComponent(kind === 'user' ? '%_' : 'OWNER') + '&sort_by=' + kind + '_name&sort_order=desc&status=verified');
      assert.equal(list.status, 200); assert.equal(list.data.total, 1); assert.equal(list.data.items[0][`${kind}_id`], id);
      assert.equal(list.data.items[0].password, undefined);
      const page1 = await manage(resource + '?limit=1'), page2 = await manage(resource + '?limit=1&page=2');
      assert.equal(page1.data.total, 2); assert.equal(page1.data.hasNextPage, true); assert.equal(page2.data.hasPreviousPage, true);
      assert.notEqual(page1.data.items[0][`${kind}_id`], page2.data.items[0][`${kind}_id`]);
      assert.equal((await manage(resource + '?search=' + encodeURIComponent("' OR 1=1 --"))).data.total, 0);
      assert.equal((await manage(resource + '?page=9')).data.items.length, 0);
      for (const query of ['page=0', 'limit=101', 'sort_by=password', 'search_column=password', 'sort_order=sideways', 'search=x&search=y', 'status=invalid', 'gender=x', 'unknown=x']) assert.equal((await manage(resource + '?' + query)).status, 400);
      people[kind] = { id, body, otherId: other.data[`${kind}_id`], otherBody };
    }
  });

  let delegated, delegatedId, delegatedRole, userModule, ownerModule;
  await t.test('Live module grants control admin profile/account operations', async () => {
    const role = await manage('roles', 'POST', { role_type: 'People operator' }); delegatedRole = role.data.role_id;
    const created = await manage('admins', 'POST', { admin_name: 'Operator', admin_username: 'people_operator', admin_email: 'operator@example.test', password, role_id: delegatedRole }); delegatedId = created.data.admin_id;
    const logged = await request('/api/admin/auth/login', 'POST', { email: 'operator@example.test', password }); delegated = logged.cookie;
    userModule = (await manage('modules', 'POST', { module_key: 'user_management', module_name: 'User Management' })).data.module_id;
    ownerModule = (await manage('modules', 'POST', { module_key: 'owner_management', module_name: 'Owner Management' })).data.module_id;
    for (const resource of ['users', 'owners']) assert.equal((await manage(resource, 'GET', undefined, delegated)).status, 403);
    assert.equal((await manage('admin-permissions', 'POST', { admin_id: delegatedId, role_id: delegatedRole, module_id: userModule, view: true })).status, 200);
    assert.equal((await manage('users', 'GET', undefined, delegated)).status, 200);
    assert.equal((await manage(`users/${people.user.id}/accounts`, 'GET', undefined, delegated)).status, 200);
    assert.equal((await manage('users', 'POST', userBody('9876500003'), delegated)).status, 403);
    assert.equal((await manage(`users/${people.user.id}`, 'PUT', { reason: 'No edit grant' }, delegated)).status, 403);
    assert.equal((await manage(`users/${people.user.id}`, 'DELETE', undefined, delegated)).status, 403);
    assert.equal((await manage(`users/${people.user.id}/accounts`, 'POST', bankBody('1000000001'), delegated)).status, 403);
    assert.equal((await manage('admin-permissions', 'POST', [
      { admin_id: delegatedId, role_id: delegatedRole, module_id: userModule, edit: true },
      { admin_id: delegatedId, role_id: delegatedRole, module_id: ownerModule, all: true },
    ])).status, 200);
    assert.equal((await manage(`users/${people.user.id}`, 'PUT', { reason: 'Allowed edit' }, delegated)).status, 200);
    assert.equal((await manage(`owners/${people.owner.id}`, 'PUT', { kyc_verification: true }, delegated)).status, 200);
    assert.equal((await manage('users', 'POST', userBody('9876500003'), delegated)).status, 403, 'Edit does not imply create');
    assert.equal((await manage('roles', 'POST', { role_type: 'Forbidden' }, delegated)).status, 403, 'Security writes still require super admin');
  });

  async function loginPerson(kind, body) {
    if (kind === 'owner') return request('/api/owner/auth/login', 'POST', { email: body.email, password });
    const challenge = await request('/api/user/auth/login', 'POST', { country_code: body.country_code, user_phone_number: body.user_phone_number });
    assert.equal(challenge.status, 200);
    return request('/api/user/auth/verify-otp', 'POST', { otp: '1111', otp_token: challenge.data.otp_token });
  }

  for (const kind of ['user', 'owner']) await t.test(`${kind} account ownership, updates, defaults and concurrent five-account cap`, async () => {
    const record = people[kind], prefix = `/api/${kind}/accounts`, adminPath = `${kind}s/${record.id}/accounts`;
    const logged = await loginPerson(kind, record.body), otherLogin = await loginPerson(kind, record.otherBody);
    assert.equal(logged.status, 200); assert.equal(otherLogin.status, 200);
    record.cookie = logged.cookie;
    const self = (path = '', method = 'GET', body, cookie = logged.cookie) => request(prefix + path, method, body, cookie);
    assert.equal((await self('', 'GET', undefined, '')).status, 401);
    assert.equal((await self('', 'GET', undefined, admin)).status, 401, 'Admin cookie cannot impersonate self-service user/owner');
    for (const field of ['account_number', 'branch_address', 'ifsc_code', 'branch_name', 'account_holder_name']) {
      const body = bankBody('0000000001'); delete body[field]; assert.equal((await self('', 'POST', body)).status, 400, field);
    }
    for (const patch of [{ account_number: 12345678 }, { account_number: 'abc1234567' }, { ifsc_code: 'INVALID' }, { branch_address: '' }, { is_default: 'true' }, { [`${kind}_id`]: record.otherId }]) assert.equal((await self('', 'POST', { ...bankBody('0000000001'), ...patch })).status, 400);
    const first = await self('', 'POST', bankBody('0000000001')); assert.equal(first.status, 201, first.message);
    assert.equal(first.data.account_number, '0000000001', 'Leading zeros preserved'); assert.equal(first.data.ifsc_code, 'SBIN0001234'); assert.equal(first.data.is_default, true);
    const id = first.data[`${kind}_account_id`]; record.accountId = id;
    assert.equal((await self('/' + id)).status, 200);
    assert.equal((await self('/' + id, 'GET', undefined, otherLogin.cookie)).status, 404, 'Cannot get another person account');
    assert.equal((await self('/' + id, 'PUT', { is_default: true }, otherLogin.cookie)).status, 404);
    assert.equal((await self('?user_id=' + record.otherId)).status, 400);
    assert.equal((await self('/missing')).status, 404);
    for (const patch of [{ account_number: '0000000002' }, { is_default: true, branch_address: 'Unallowed' }, {}, { is_default: 'true' }]) assert.equal((await self('/' + id, 'PUT', patch)).status, 400);
    assert.equal((await manage(`${kind}s/${record.otherId}/accounts/${id}`, 'PUT', { branch_name: 'Wrong parent' })).status, 404);
    assert.equal((await manage(adminPath + '/' + id, 'PUT', { branch_address: 'Admin corrected address', account_holder_name: 'Corrected Holder' }, delegated)).status, 200);
    assert.equal((await self('/' + id)).data.branch_address, 'Admin corrected address');
    assert.equal((await manage(adminPath + '/' + id, 'PUT', { [`${kind}_id`]: record.otherId })).status, 400);
    const second = await self('', 'POST', { ...bankBody('0000000002'), is_default: true }); assert.equal(second.status, 201);
    const secondId = second.data[`${kind}_account_id`];
    assert.equal((await self('/' + id)).data.is_default, false);
    assert.equal((await self('/' + secondId, 'PUT', { is_default: false })).status, 200);
    assert.equal((await self('?is_default=true')).data.total, 0, 'Zero defaults is permitted when explicitly cleared');
    assert.equal((await self('/' + id, 'PUT', { is_default: true })).status, 200);
    const duplicate = await self('', 'POST', { ...bankBody('0000000002'), is_default: true }); assert.equal(duplicate.status, 409);
    assert.equal((await self('/' + id)).data.is_default, true, 'Duplicate failure rolls back default changes');
    const list = await self('?page=1&limit=1&search_column=branch_name&search=central&sort_by=account_number&sort_order=desc');
    assert.equal(list.status, 200); assert.equal(list.data.total, 2); assert.equal(list.data.hasNextPage, true); assert.equal(list.data.items[0].account_number, '0000000002');
    assert.equal((await self('?is_default=true')).data.items[0][`${kind}_account_id`], id);
    assert.equal((await manage(adminPath + '?account_number=0000000001')).data.total, 1);
    for (const query of ['page=0', 'limit=101', 'sort_by=password', 'is_default=yes', 'search=x&search=y']) assert.equal((await self('?' + query)).status, 400);
    for (const number of ['0000000003', '0000000004']) assert.equal((await self('', 'POST', bankBody(number))).status, 201);
    const concurrent = await Promise.all([self('', 'POST', bankBody('0000000005')), manage(adminPath, 'POST', bankBody('0000000006'))]);
    assert.deepEqual(concurrent.map(row => row.status).sort(), [201, 409]);
    assert.equal((await self()).data.total, 5);
    assert.equal((await self('', 'POST', bankBody('0000000007'))).status, 409);
    assert.equal((await manage(adminPath, 'POST', bankBody('0000000007'))).status, 409);
    const defaults = await Promise.all([self('/' + id, 'PUT', { is_default: true }), self('/' + secondId, 'PUT', { is_default: true })]);
    assert.deepEqual(defaults.map(row => row.status), [200, 200]);
    assert.equal((await self('?is_default=true')).data.total, 1);
    await assert.rejects(pool.query(`INSERT INTO public.${kind}_account_details(${kind}_id,${kind}_account_id) VALUES($1,$2)`, [record.id, generateId()]), error => error.code === '23514' && error.constraint === 'bank_account_limit');
    await assert.rejects(pool.query(`UPDATE public.${kind}_account_details SET ${kind}_id=$1 WHERE ${kind}_account_id=$2`, [record.otherId, id]), error => error.code === '23514' && error.constraint === 'bank_account_owner_immutable');
    const other = await self('', 'POST', { ...bankBody('0000000001'), is_default: false }, otherLogin.cookie);
    assert.equal(other.status, 201, 'Same number can belong to another person'); assert.equal(other.data.is_default, false);
    for (let i = 0; i < 3; i++) await pool.query(`INSERT INTO public.${kind}_account_details(${kind}_id,${kind}_account_id) VALUES($1,$2)`, [record.otherId, generateId()]);
    const direct = await Promise.allSettled([0, 1].map(() => pool.query(`INSERT INTO public.${kind}_account_details(${kind}_id,${kind}_account_id) VALUES($1,$2)`, [record.otherId, generateId()])));
    assert.equal(direct.filter(row => row.status === 'fulfilled').length, 1, 'Database trigger also serializes concurrent SQL inserts');
    assert.equal(direct.find(row => row.status === 'rejected').reason.constraint, 'bank_account_limit');
    assert.equal((await request(prefix + '/' + id, 'PUT', { is_default: true }, logged.cookie, { origin: 'https://evil.example' })).status, 403);
  });

  await t.test('Permission revocation, stale role grants and service rechecks', async () => {
    const revoke = await manage('admin-permissions', 'POST', { admin_id: delegatedId, role_id: delegatedRole, module_id: userModule, view: false, read: false });
    assert.equal(revoke.status, 200);
    assert.equal((await manage('users', 'GET', undefined, delegated)).status, 403);
    assert.equal((await manage(`users/${people.user.id}/accounts/${people.user.accountId}`, 'GET', undefined, delegated)).status, 403);
    const alternateRole = (await manage('roles', 'POST', { role_type: 'Unrelated' })).data.role_id;
    await assert.rejects(pool.query('UPDATE public.admin_permission SET role_id=$1 WHERE admin_id=$2 AND module_id=$3', [alternateRole, delegatedId, ownerModule]), error => error.code === '23503', 'Database also rejects stale role grants');
    assert.equal((await manage('admin-permissions', 'POST', { admin_id: delegatedId, role_id: delegatedRole, module_id: ownerModule, all: false, create: false, read: false, view: false, edit: false, delete: false })).status, 200);
    assert.equal((await manage('owners', 'GET', undefined, delegated)).status, 403, 'Revoked grants take effect for existing sessions');
    await assert.rejects(require('../dist/services/personManagementService').writePerson('owner', 'update', { adminId: delegatedId, sessionToken: delegated.split('=')[1] }, { reason: 'Denied service call' }, people.owner.id), /Permission denied/);
    await assert.rejects(require('../dist/services/bankAccountService').writeBankAccount('owner', people.owner.id, { type: 'admin', actor: { adminId: delegatedId, sessionToken: delegated.split('=')[1] } }, { branch_name: 'Denied service call' }, people.owner.accountId), /Permission denied/);
  });

  await t.test('Contact changes, status changes and soft deletion preserve account history', async () => {
    for (const kind of ['user', 'owner']) {
      const record = people[kind], path = `${kind}s/${record.id}`;
      const token = kind === 'user'
        ? (await request('/api/user/auth/login', 'POST', { country_code: record.body.country_code, user_phone_number: record.body.user_phone_number })).data.otp_token
        : (await request('/api/owner/auth/send-otp', 'POST', { type: 'email', email: record.body.email })).data.otp_token;
      if (kind === 'owner') await pool.query('UPDATE public.owner SET is_email_verified=true,is_phone_number_verified=true WHERE owner_id=$1', [record.id]);
      const changed = await manage(path, 'PUT', kind === 'user' ? { user_phone_number: '9876500090' } : { owner_phone_number: '9876600090', email: 'new-owner@example.test' });
      assert.equal(changed.status, 200); assert.equal(changed.data.is_phone_number_verified, false);
      if (kind === 'owner') assert.equal(changed.data.is_email_verified, false);
      assert.equal((await request(`/api/${kind}/auth/me`, 'GET', undefined, record.cookie)).status, 401);
      assert.equal((await request(`/api/${kind}/auth/verify-otp`, 'POST', { otp: '1111', otp_token: token })).status, 401);
      assert.equal((await manage(path, 'PUT', kind === 'user' ? { is_active: false, reason: 'Disabled' } : { status: 'blocked', reason: 'Disabled' })).status, 200);
      if (kind === 'owner') assert.equal((await request('/api/owner/auth/login', 'POST', { email: 'new-owner@example.test', password })).status, 401);
      else {
        const challenge = await request('/api/user/auth/login', 'POST', { country_code: '+91', user_phone_number: '9876500090' });
        assert.equal((await request('/api/user/auth/verify-otp', 'POST', { otp: '1111', otp_token: challenge.data.otp_token })).status, 401);
      }
      assert.equal((await manage(path, 'DELETE')).status, 200);
      const deleted = await manage(path); assert.equal(deleted.status, 200); assert.equal(deleted.data.status, 'deleted');
      if (kind === 'user') assert.equal(deleted.data.is_active, false);
      assert.equal((await manage(path + '/accounts')).data.total, 5, 'Soft deletion preserves bank details');
      assert.equal((await manage(`${kind}s?status=deleted`)).data.total, 1);
      assert.equal((await manage(`${kind}s/missing`, 'DELETE')).status, 404);
      assert.equal((await request('/api/admin/' + path, 'PUT', { reason: 'Bad origin' }, admin, { 'sec-fetch-site': 'cross-site' })).status, 403);
    }
  });
  await runMigrations();
});
