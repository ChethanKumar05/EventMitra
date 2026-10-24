const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const url = process.env.USER_TEST_DATABASE_URL;

test('User signup and phone OTP authentication HTTP/PostgreSQL integration', {
  skip: !url && 'Set USER_TEST_DATABASE_URL to a fresh isolated *_test database',
}, async t => {
  assert.match(new URL(url).pathname, /_test$/);
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
  const { pool } = require('../dist/config/database');
  const { runMigrations } = require('../dist/migrations/runMigrations');
  const { digest } = require('../dist/security/password');
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  assert.equal((await pool.query("SELECT to_regclass('public.user') AS existing")).rows[0].existing, null, 'Use a fresh empty integration database');
  await runMigrations();
  const { app } = require('../dist/app');
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = 'GET', body, cookie, extra = {}) {
    const response = await fetch(origin + path, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { ...await response.json(), status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  const post = (path, body) => request('/api/user/auth/' + path, 'POST', body);
  const signup = body => post('signup', body);
  const login = body => post('login', body);
  const resend = body => post('resend-otp', body);
  const verify = (otp_token, otp = '1111') => post('verify-otp', { otp_token, otp });
  const me = cookie => request('/api/user/auth/me', 'GET', undefined, cookie);
  const clearLimits = () => pool.query('DELETE FROM public.user_otp_limits');
  const phone = { country_code: '+91', user_phone_number: '9876543210' };
  const input = { ...phone, gender: 'f', user_name: '  Test   User  ', email: 'USER@EXAMPLE.TEST', profile_image: '/uploads/user.jpg', whatsapp_number: '+919876543210', alternative_number: '9876543211' };

  assert.equal((await request('/api/user/health')).status, 200, 'Existing health route remains available');
  assert.equal((await me()).status, 401);
  for (const field of ['country_code', 'user_phone_number', 'gender', 'user_name']) {
    const body = { ...input }; delete body[field];
    assert.equal((await signup(body)).status, 400, 'Required ' + field);
  }
  for (const body of [null, [], {}, { ...input, user_name: ' ' }, { ...input, user_name: 'x'.repeat(151) }, { ...input, user_name: 'bad\nname' },
    { ...input, country_code: '91' }, { ...input, country_code: '+0' }, { ...input, user_phone_number: 9876543210 },
    { ...input, user_phone_number: '123' }, { ...input, user_phone_number: '+919876543210' }, { ...input, country_code: '+123', user_phone_number: '1234567890123' },
    { ...input, gender: 'x' }, { ...input, email: 'bad@' }, { ...input, profile_image: {} }, { ...input, whatsapp_number: 'letters' }, { ...input, alternative_number: 123 },
    { ...input, status: 'verified' }, { ...input, user_id: 'attacker' }, { ...input, user_code: 'USR00001' }, { ...input, is_active: true }, { ...input, is_phone_number_verified: true }, { ...input, password: 'not-used' }]) {
    assert.equal((await signup(body)).status, 400, JSON.stringify(body));
  }
  const created = await signup(input);
  assert.equal(created.status, 201);
  assert.equal(created.data.user_code, 'USR00001');
  assert.equal(created.data.user_name, 'Test User');
  assert.equal(created.data.email, 'user@example.test');
  assert.equal(created.data.status, 'pending');
  assert.equal(created.data.is_active, true);
  assert.equal(created.data.is_phone_number_verified, false);
  assert.equal(created.cookie, undefined, 'Signup does not authenticate an unverified phone');
  const id = created.data.user_id;
  assert.equal((await signup({ ...input, email: 'other@example.test' })).status, 409);
  assert.equal((await signup({ ...input, user_phone_number: '9876543212' })).status, 409, 'Email uniqueness ignores case');
  const optional = await signup({ country_code: '+1', user_phone_number: phone.user_phone_number, gender: 'm', user_name: input.user_name });
  assert.equal(optional.status, 201, 'Country code distinguishes phone identities; names need not be unique');
  for (const field of ['email', 'profile_image', 'whatsapp_number', 'alternative_number']) assert.equal(optional.data[field], null);
  const nullable = await signup({ country_code: '+91', user_phone_number: '9876543213', gender: 'm', user_name: 'Nullable', email: '', profile_image: null, whatsapp_number: '', alternative_number: null });
  assert.equal(nullable.status, 201);

  for (const fn of [login, resend]) {
    for (const body of [null, [], {}, { country_code: '+91' }, { user_phone_number: phone.user_phone_number }, { ...phone, country_code: 91 }, { ...phone, user_phone_number: 'bad' }, { ...phone, email: 'user@example.test' }, { ...phone, password: 'not-used' }]) assert.equal((await fn(body)).status, 400);
  }
  for (const body of [{}, { otp: 1111, otp_token: 'a'.repeat(64) }, { otp: '1111', otp_token: 'bad' }, { otp: '111', otp_token: 'a'.repeat(64) }, { otp: '1111', otp_token: 'a'.repeat(64), ...phone }]) assert.equal((await post('verify-otp', body)).status, 400);

  const challenge = await login(phone);
  assert.equal(challenge.status, 200);
  assert.equal(challenge.cookie, undefined, 'Only verification can issue a session');
  assert.equal(challenge.headers.get('cache-control'), 'no-store');
  assert.equal(challenge.data.expires_in, 300);
  assert.equal(challenge.data.delivery, 'development-fixed-otp');
  const token = challenge.data.otp_token;
  assert.match(token, /^[a-f0-9]{64}$/);
  const stored = (await pool.query('SELECT * FROM public.user_phone_verification WHERE otp_token=$1', [digest(token)])).rows[0];
  assert.equal(stored.user_id, undefined);
  assert.equal(stored.country_code, phone.country_code);
  assert.equal(stored.user_phone_number, phone.user_phone_number);
  assert.notEqual(stored.otp, '1111');
  assert.equal(stored.otp, digest(`${token}:1111`));
  assert.notEqual(stored.otp_token, token);
  assert.equal((await verify(token, '2222')).status, 401);
  assert.equal((await pool.query('SELECT attempts FROM public.user_phone_verification WHERE otp_token=$1', [digest(token)])).rows[0].attempts, 1, 'Wrong attempts persist');
  const logged = await verify(token);
  assert.equal(logged.status, 200);
  assert.equal(logged.data.user_id, id);
  assert.equal(logged.data.is_phone_number_verified, true);
  assert.equal(logged.data.status, 'pending', 'OTP does not change administrative approval status');
  assert.equal(logged.data.otp, undefined); assert.equal(logged.data.account_fingerprint, undefined);
  assert.match(logged.headers.get('set-cookie'), /^eventmitra_user_session=[a-f0-9]{64}/);
  assert.match(logged.headers.get('set-cookie'), /HttpOnly/);
  assert.match(logged.headers.get('set-cookie'), /SameSite=Strict/);
  assert.match(logged.headers.get('set-cookie'), /Max-Age=28800/);
  const session = logged.cookie.split('=')[1];
  assert.equal((await pool.query('SELECT token_hash FROM public.user_sessions WHERE user_id=$1', [id])).rows[0].token_hash, digest(session));
  assert.equal((await me(logged.cookie)).data.user_id, id);
  assert.equal((await verify(token)).status, 401, 'Successful OTP is single use');

  const old = await login(phone), replacement = await resend(phone);
  assert.notEqual(old.data.otp_token, replacement.data.otp_token);
  assert.equal((await verify(old.data.otp_token)).status, 401, 'Resend invalidates older login token');
  const second = await verify(replacement.data.otp_token);
  assert.equal(second.status, 200);
  const logout = await request('/api/user/auth/logout', 'POST', undefined, logged.cookie);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await me(logged.cookie)).status, 401);
  assert.equal((await me(second.cookie)).status, 200, 'Logout only revokes current session');
  assert.equal((await request('/api/user/auth/logout', 'POST')).status, 200);
  assert.equal((await request('/api/user/auth/logout', 'POST', undefined, 'eventmitra_user_session=bad')).status, 200);

  // Authentication namespaces are isolated even if someone renames a valid cookie.
  assert.equal((await request('/api/admin/auth/me', 'GET', undefined, second.cookie)).status, 401);
  assert.equal((await request('/api/owner/auth/me', 'GET', undefined, second.cookie)).status, 401);
  assert.equal((await request('/api/admin/auth/me', 'GET', undefined, 'eventmitra_session=' + second.cookie.split('=')[1])).status, 401);
  assert.equal((await request('/api/owner/auth/me', 'GET', undefined, 'eventmitra_owner_session=' + second.cookie.split('=')[1])).status, 401);
  assert.equal((await me('eventmitra_owner_session=' + second.cookie.split('=')[1])).status, 401);

  await clearLimits();
  const exhausted = await login(phone);
  for (let attempt = 0; attempt < 4; attempt++) assert.equal((await verify(exhausted.data.otp_token, '2222')).status, 401);
  assert.equal((await verify(exhausted.data.otp_token, '2222')).status, 429);
  assert.equal((await verify(exhausted.data.otp_token)).status, 429);
  const expired = await resend(phone);
  await pool.query("UPDATE public.user_phone_verification SET expires_at=now()-interval '1 second' WHERE otp_token=$1", [digest(expired.data.otp_token)]);
  assert.equal((await verify(expired.data.otp_token)).status, 401);
  const concurrent = await resend(phone);
  const concurrentResults = await Promise.all([verify(concurrent.data.otp_token), verify(concurrent.data.otp_token)]);
  assert.deepEqual(concurrentResults.map(result => result.status).sort(), [200, 401], 'Concurrent verification creates one session');
  const concurrentSession = concurrentResults.find(result => result.status === 200).cookie;

  // Status/inactive changes made directly through SQL revoke challenges and sessions permanently.
  await pool.query("UPDATE public.\"user\" SET status='verified' WHERE user_id=$1", [id]);
  assert.equal((await me(concurrentSession)).status, 200);
  const beforeBlock = await login(phone);
  await pool.query("UPDATE public.\"user\" SET status='blocked' WHERE user_id=$1", [id]);
  assert.equal((await me(concurrentSession)).status, 401);
  await pool.query("UPDATE public.\"user\" SET status='pending' WHERE user_id=$1", [id]);
  assert.equal((await verify(beforeBlock.data.otp_token)).status, 401, 'Unblocking does not restore challenges');
  assert.equal((await me(concurrentSession)).status, 401, 'Unblocking does not restore sessions');
  await clearLimits();
  for (const status of ['blocked', 'deleted', 'hold', 'rejected', 'unknown']) {
    await pool.query('UPDATE public."user" SET status=$1 WHERE user_id=$2', [status, id]);
    const disallowed = await login(phone);
    assert.equal(disallowed.status, 200, 'Do not expose account eligibility');
    assert.equal((await verify(disallowed.data.otp_token)).status, 401);
  }
  await pool.query("UPDATE public.\"user\" SET status='pending',is_active=false WHERE user_id=$1", [id]);
  await clearLimits();
  const inactive = await login(phone);
  assert.equal((await verify(inactive.data.otp_token)).status, 401);
  await pool.query('UPDATE public."user" SET is_active=true WHERE user_id=$1', [id]);
  const active = await verify((await login(phone)).data.otp_token);
  assert.equal(active.status, 200);
  await pool.query('UPDATE public."user" SET is_active=false WHERE user_id=$1', [id]);
  await pool.query('UPDATE public."user" SET is_active=true WHERE user_id=$1', [id]);
  assert.equal((await me(active.cookie)).status, 401, 'Reactivation does not restore sessions');

  const changed = await verify((await login(phone)).data.otp_token);
  assert.equal(changed.status, 200);
  const preChange = await login(phone);
  await pool.query('UPDATE public."user" SET user_phone_number=$1 WHERE user_id=$2', ['9876543220', id]);
  assert.equal((await me(changed.cookie)).status, 401);
  assert.equal((await verify(preChange.data.otp_token)).status, 401);
  await pool.query('UPDATE public."user" SET user_phone_number=$1 WHERE user_id=$2', [phone.user_phone_number, id]);
  assert.equal((await me(changed.cookie)).status, 401);
  await clearLimits();
  const revokedVerification = await verify((await login(phone)).data.otp_token);
  await pool.query('UPDATE public."user" SET is_phone_number_verified=false WHERE user_id=$1', [id]);
  assert.equal((await me(revokedVerification.cookie)).status, 401);
  const expiringSession = await verify((await login(phone)).data.otp_token);
  await pool.query("UPDATE public.user_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [digest(expiringSession.cookie.split('=')[1])]);
  assert.equal((await me(expiringSession.cookie)).status, 401);

  // A challenge cannot authenticate an account created later or a replacement using the same phone.
  const unknownPhone = { country_code: '+91', user_phone_number: '9876543230' };
  const unknown = await login(unknownPhone);
  assert.equal(unknown.status, 200);
  assert.deepEqual(Object.keys(unknown.data), Object.keys(challenge.data));
  assert.equal((await verify(unknown.data.otp_token)).status, 401);
  assert.equal((await signup({ ...unknownPhone, user_name: 'Created after challenge', gender: 'm' })).status, 201);
  assert.equal((await verify(unknown.data.otp_token)).status, 401);
  const stale = await login(unknownPhone);
  await pool.query('DELETE FROM public."user" WHERE country_code=$1 AND user_phone_number=$2', Object.values(unknownPhone));
  const recreated = await signup({ ...unknownPhone, user_name: 'Replacement', gender: 'f' });
  assert.equal(recreated.status, 201);
  assert.equal((await verify(stale.data.otp_token)).status, 401);
  const fresh = await verify((await login(unknownPhone)).data.otp_token);
  assert.equal(fresh.status, 200);
  await pool.query('DELETE FROM public."user" WHERE user_id=$1', [recreated.data.user_id]);
  assert.equal((await me(fresh.cookie)).status, 401);

  for (const path of ['signup', 'login', 'resend-otp', 'verify-otp', 'logout']) {
    assert.equal((await request('/api/user/auth/' + path, 'POST', {}, undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/user/auth/' + path, 'POST', {}, undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  }
  assert.equal((await request('/api/user/auth/logout', 'POST', undefined, undefined, { origin })).status, 200);
  await clearLimits();
  for (let i = 0; i < 5; i++) assert.equal((await (i % 2 ? resend(phone) : login(phone))).status, 200);
  assert.equal((await login(phone)).status, 429, 'Login and resend share phone budget');
  await pool.query("UPDATE public.user_otp_limits SET window_start=now()-interval '16 minutes'");
  assert.equal((await resend(phone)).status, 200, 'Budget resets after window');
  await pool.query('UPDATE public.user_otp_limits SET attempts=20 WHERE attempt_key=$1', [digest('otp-ip:127.0.0.1')]);
  assert.equal((await login({ country_code: '+91', user_phone_number: '9876543299' })).status, 429, 'IP limit covers cycling through phone numbers');
  await pool.query("INSERT INTO public.user_otp_limits(attempt_key,attempts) VALUES($1,100) ON CONFLICT(attempt_key) DO UPDATE SET attempts=100", [digest('verify-ip:127.0.0.1')]);
  assert.equal((await verify('a'.repeat(64))).status, 429, 'Verification limits random token attempts');
  await pool.query("INSERT INTO public.user_otp_limits(attempt_key,attempts) VALUES($1,20) ON CONFLICT(attempt_key) DO UPDATE SET attempts=20", [digest('signup-ip:127.0.0.1')]);
  assert.equal((await signup({ ...phone, user_phone_number: '9876543298', user_name: 'Limited', gender: 'm' })).status, 429);
  const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='user_phone_verification'")).rows.map(row => row.column_name);
  assert.equal(columns.includes('user_id'), false);
  assert.ok(columns.includes('otp_token') && columns.includes('country_code') && columns.includes('user_phone_number'));
  process.env.NODE_ENV = 'production';
  try {
    assert.equal((await login(phone)).status, 503);
    assert.equal((await resend(phone)).status, 503);
    assert.equal((await verify(token)).status, 503);
  } finally { process.env.NODE_ENV = 'test'; }
  await runMigrations(); // Re-running migration runner must skip all applied files.
});
