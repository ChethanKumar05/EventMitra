const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const url=process.env.OWNER_TEST_DATABASE_URL;
test('Owner login/logout HTTP and PostgreSQL integration',{skip:!url&&'Set OWNER_TEST_DATABASE_URL to a fresh isolated *_test database'},async t=>{
  assert.match(new URL(url).pathname,/_test$/);
  process.env.DATABASE_URL=url;process.env.NODE_ENV='test';
  const {pool}=require('../dist/config/database');
  const {runMigrations}=require('../dist/migrations/runMigrations');
  const {hashPassword,digest}=require('../dist/security/password');
  const {generateId}=require('../dist/utils/id');
  let server;
  t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await pool.end();});
  assert.equal((await pool.query("SELECT to_regclass('public.owner') AS existing")).rows[0].existing,null,'Use a fresh empty owner integration database');
  await runMigrations();
  const password='Owner-test-'+randomBytes(16).toString('hex');
  const hashed=await hashPassword(password);
  let fixtureNumber=0;
  async function owner(name,status='pending',storedHash=hashed){
    const number=++fixtureNumber,id=generateId(),email=`owner-${number}@example.test`;
    await pool.query(`INSERT INTO public.owner(owner_id,owner_code,country_code,owner_phone_number,owner_name,email,password,status,doc_json,doc_number)
      VALUES ($1,$1,'+91',$2,$3,$4,$5,$6,'{"private":"do-not-return"}'::jsonb,'private-document')`,[id,String(9000000000+number),name,email,storedHash,status]);
    return {owner_id:id,owner_name:name,email};
  }
  const pending=await owner('Ravi Kumar');
  const verified=await owner('Verified Owner','verified');
  const duplicateA=await owner('Shared Owner');
  const duplicateB=await owner('Shared Owner','verified');
  const {app}=require('../dist/app');server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function request(path,method='GET',body,cookie,extra={}){
    const response=await fetch(origin+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{cookie}:{}),...extra},body:body!==undefined?JSON.stringify(body):undefined});
    return {...await response.json(),status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  const login=body=>request('/api/owner/auth/login','POST',body);
  const me=cookie=>request('/api/owner/auth/me','GET',undefined,cookie);
  const assertPublic=record=>assert.deepEqual(Object.keys(record).sort(),['owner_id','owner_code','owner_name','email','status','kyc_verification','is_phone_number_verified'].sort());
  assert.equal((await me()).status,401);
  for(const body of [{},[],null,{password},{email:pending.email,owner_name:pending.owner_name,password},{email:'invalid',password},{owner_name:123,password},{owner_name:'   ',password},{owner_name:'x'.repeat(151),password},{owner_name:'bad\nname',password},{email:pending.email},{email:pending.email,password:''},{email:pending.email,password:123},{email:pending.email,password:'x'.repeat(257)}]){
    assert.equal((await login(body)).status,400);
  }
  assert.equal((await login({email:pending.email,password:'wrong'})).status,401);
  assert.equal((await login({owner_name:'unknown',password})).status,401);
  assert.equal((await login({owner_name:"' OR 1=1 --",password})).status,401);
  const pendingLogin=await login({email:pending.email.toUpperCase(),password});assert.equal(pendingLogin.status,200);assert.equal(pendingLogin.data.status,'pending');assertPublic(pendingLogin.data);
  assert.match(pendingLogin.headers.get('set-cookie'),/^eventmitra_owner_session=[a-f0-9]{64}/);
  assert.match(pendingLogin.headers.get('set-cookie'),/HttpOnly/);assert.match(pendingLogin.headers.get('set-cookie'),/SameSite=Strict/);assert.match(pendingLogin.headers.get('set-cookie'),/Max-Age=28800/);
  assert.equal(pendingLogin.headers.get('cache-control'),'no-store');
  const rawToken=pendingLogin.cookie.split('=')[1],stored=(await pool.query('SELECT * FROM public.owner_sessions WHERE owner_id=$1',[pending.owner_id])).rows[0];
  assert.equal(stored.token_hash,digest(rawToken));assert.notEqual(stored.token_hash,rawToken);assert.equal(stored.password_fingerprint,digest(hashed));
  const current=await me(pendingLogin.cookie);assert.equal(current.status,200);assert.equal(current.data.owner_id,pending.owner_id);assertPublic(current.data);
  assert.equal((await request('/api/admin/auth/me','GET',undefined,pendingLogin.cookie)).status,401);
  const pendingByName=await login({owner_name:'  RAVI KUMAR  ',password});assert.equal(pendingByName.status,200);assert.equal(pendingByName.data.owner_id,pending.owner_id);
  const verifiedLogin=await login({owner_name:'verified owner',password});assert.equal(verifiedLogin.status,200);assert.equal(verifiedLogin.data.status,'verified');assertPublic(verifiedLogin.data);
  assert.equal((await login({owner_name:'Shared Owner',password})).status,401,'Duplicate owner names require email');
  for(const record of [duplicateA,duplicateB])assert.equal((await login({email:record.email,password})).status,200);
  for(const status of ['rejected','blocked','hold','deleted']){
    const record=await owner('Status '+status,status);
    assert.equal((await login({email:record.email,password})).status,401);
    assert.equal((await login({owner_name:record.owner_name,password})).status,401);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.owner_sessions WHERE owner_id=$1',[record.owner_id])).rows[0].n,0);
  }
  const plaintext=await owner('Legacy plaintext','pending','unsafe-plaintext-password');
  assert.equal((await login({email:plaintext.email,password:'unsafe-plaintext-password'})).status,401,'Plaintext passwords are never accepted as hashes');

  // Admin and owner cookies/tokens belong to separate authentication namespaces.
  await require('../dist/services/adminAuthService').bootstrapSuperAdmin({name:'Owner test admin',username:'owner_test_admin',email:'owner-admin@example.test',password});
  const admin=await request('/api/admin/auth/login','POST',{email:'owner-admin@example.test',password});assert.equal(admin.status,200);
  assert.equal((await me(admin.cookie)).status,401);
  assert.equal((await me('eventmitra_owner_session='+admin.cookie.split('=')[1])).status,401);
  assert.equal((await request('/api/admin/auth/me','GET',undefined,'eventmitra_session='+rawToken)).status,401);
  const combined=pendingLogin.cookie+'; '+admin.cookie;
  assert.equal((await me(combined)).status,200);
  assert.equal((await request('/api/owner/auth/logout','POST',undefined,combined)).status,200);
  assert.equal((await me(pendingLogin.cookie)).status,401);
  assert.equal((await me(pendingByName.cookie)).status,200,'Logout revokes only the presented owner session');
  assert.equal((await request('/api/admin/auth/me','GET',undefined,admin.cookie)).status,200,'Owner logout leaves admin session intact');
  const cleared=await request('/api/owner/auth/logout','POST',undefined,pendingLogin.cookie);assert.equal(cleared.status,200);assert.match(cleared.headers.get('set-cookie'),/Expires=Thu, 01 Jan 1970/);
  assert.equal((await request('/api/owner/auth/logout','POST')).status,200);
  assert.equal((await request('/api/owner/auth/logout','POST',undefined,'eventmitra_owner_session=bad')).status,200);

  // Status and password updates revoke sessions, including changes made directly through SQL.
  await pool.query("UPDATE public.owner SET status='verified' WHERE owner_id=$1",[pending.owner_id]);
  assert.equal((await me(pendingByName.cookie)).status,200,'Pending to verified approval preserves eligible session');
  await pool.query("UPDATE public.owner SET status='blocked' WHERE owner_id=$1",[pending.owner_id]);
  assert.equal((await me(pendingByName.cookie)).status,401);
  await pool.query("UPDATE public.owner SET status='pending' WHERE owner_id=$1",[pending.owner_id]);
  assert.equal((await me(pendingByName.cookie)).status,401,'Unblocking never restores a revoked session');
  const expiring=await login({email:verified.email,password});assert.equal(expiring.status,200);
  await pool.query("UPDATE public.owner_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[digest(expiring.cookie.split('=')[1])]);assert.equal((await me(expiring.cookie)).status,401);
  const changed=await owner('Password change');const beforeChange=await login({email:changed.email,password});assert.equal(beforeChange.status,200);
  const newPassword='New-'+password,newHash=await hashPassword(newPassword);await pool.query('UPDATE public.owner SET password=$1 WHERE owner_id=$2',[newHash,changed.owner_id]);
  assert.equal((await me(beforeChange.cookie)).status,401);
  assert.equal((await login({email:changed.email,password})).status,401);
  const afterChange=await login({email:changed.email,password:newPassword});assert.equal(afterChange.status,200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.owner_sessions WHERE token_hash=$1',[digest(expiring.cookie.split('=')[1])])).rows[0].n,0,'Login prunes expired sessions');
  await pool.query('DELETE FROM public.owner WHERE owner_id=$1',[changed.owner_id]);assert.equal((await me(afterChange.cookie)).status,401);

  for(const [path,body] of [['/api/owner/auth/login',{email:verified.email,password}],['/api/owner/auth/logout',undefined]]){
    assert.equal((await request(path,'POST',body,verifiedLogin.cookie,{origin:'https://evil.example'})).status,403);
    assert.equal((await request(path,'POST',body,verifiedLogin.cookie,{'sec-fetch-site':'cross-site'})).status,403);
  }
  assert.equal((await request('/api/owner/auth/logout','POST',undefined,verifiedLogin.cookie,{origin})).status,200);
  const throttle=await owner('Throttle Owner');
  for(let i=0;i<10;i++)assert.equal((await login(i%2?{owner_name:throttle.owner_name.toUpperCase(),password:'wrong'}:{email:throttle.email,password:'wrong'})).status,401);
  assert.equal((await login({email:throttle.email,password})).status,429,'Name and email share one attempt budget');
  await pool.query("UPDATE public.owner_login_attempts SET window_start=now()-interval '16 minutes' WHERE attempt_key=$1",[digest('owner-account:127.0.0.1|'+throttle.owner_id)]);
  assert.equal((await login({owner_name:throttle.owner_name,password})).status,200,'Attempt budget resets after the window');
  await pool.query('UPDATE public.owner_login_attempts SET attempts=100 WHERE attempt_key=$1',[digest('owner-ip:127.0.0.1')]);
  assert.equal((await login({owner_name:'random-unknown',password})).status,429,'IP limit protects against cycling through identifiers');
  await runMigrations();
  // Explicit URL points only to the required fresh disposable test DB.
  for(const table of ['owner_sessions','owner_login_attempts','owner','admin_sessions','admin','roles','modules','admin_login_attempts'])await pool.query('DELETE FROM public.'+table);
});
