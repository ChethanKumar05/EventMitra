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
  const duplicateA=await owner('Shared Owner A');
  const duplicateB=await owner('Shared Owner B','verified');
  const {app}=require('../dist/app');server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function request(path,method='GET',body,cookie,extra={}){
    const response=await fetch(origin+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{cookie}:{}),...extra},body:body!==undefined?JSON.stringify(body):undefined});
    return {...await response.json(),status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  const login=body=>request('/api/owner/auth/login','POST',body);
  const me=cookie=>request('/api/owner/auth/me','GET',undefined,cookie);
  const assertPublic=record=>assert.deepEqual(Object.keys(record).sort(),['owner_id','owner_code','owner_name','email','status','kyc_verification','is_email_verified','is_phone_number_verified'].sort());
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
  await assert.rejects(owner(' shared  owner a '),error=>error.code==='23505','Owner names are now unique ignoring case/whitespace');
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
  // Signup, token-based OTP and password recovery.
  await pool.query('DELETE FROM public.owner_login_attempts');
  const signupBody={owner_name:'New Signup Owner',owner_phone_number:'9876543210',country_code:'+91',email:'signup@example.test',password,
    gender:'m',doc_type:'passport',doc_number:'TEST-PASSPORT',doc_image:'/uploads/test-document.jpg',pin_code:'560001',state:'Karnataka',city:'Bengaluru',area:'Indiranagar',lat:0,long:0,address:'Test address'};
  for(const field of ['owner_name','owner_phone_number','country_code','email','password','gender','doc_type','doc_number','doc_image','pin_code','state','city','area','lat','long','address']){
    const body={...signupBody};delete body[field];assert.equal((await request('/api/owner/auth/signup','POST',body)).status,400,'Required '+field);
  }
  for(const patch of [{email:'invalid'},{owner_phone_number:9876543210},{country_code:'91'},{gender:'x'},{lat:'12.5'},{lat:91},{long:-181},{status:'verified'},{is_phone_number_verified:true},{alternative_email:'bad'},{whatsapp_number:'letters'}])assert.equal((await request('/api/owner/auth/signup','POST',{...signupBody,...patch})).status,400);
  const created=await request('/api/owner/auth/signup','POST',signupBody);assert.equal(created.status,201);assert.equal(created.data.status,'pending');assert.match(created.data.owner_code,/^OWN[0-9]{5,}$/);assert.equal(created.data.is_phone_number_verified,false);assert.equal(created.data.is_email_verified,false);
  assert.ok(!JSON.stringify(created.data).includes('TEST-PASSPORT'));assert.equal(created.data.password,undefined);
  const signupId=created.data.owner_id;const saved=(await pool.query('SELECT * FROM public.owner WHERE owner_id=$1',[signupId])).rows[0];assert.notEqual(saved.password,password);assert.equal(await require('../dist/security/password').verifyPassword(password,saved.password),true);assert.equal(Number(saved.lat),0);
  for(const patch of [{owner_name:'  NEW   signup OWNER ',email:'other1@example.test',owner_phone_number:'9876543211'},{owner_name:'Other name',email:'SIGNUP@EXAMPLE.TEST',owner_phone_number:'9876543211'},{owner_name:'Other name',email:'other2@example.test'}])assert.equal((await request('/api/owner/auth/signup','POST',{...signupBody,...patch})).status,409);
  const sessionBeforeReset=await login({owner_name:' NEW   SIGNUP Owner ',password});assert.equal(sessionBeforeReset.status,200);
  const send=(body)=>request('/api/owner/auth/send-otp','POST',body);
  const verify=(otp_token,otp='1111')=>request('/api/owner/auth/verify-otp','POST',{otp_token,otp});
  const forgot=body=>request('/api/owner/auth/forgot-password','POST',body);
  const reset=(otp_token,new_password)=>request('/api/owner/auth/reset-password','POST',{otp_token,new_password,confirm_password:new_password});
  for(const body of [{type:'fax'},{type:'email'},{type:'phone',phone_number:'9876543210'},{type:'phone',country_code:'+91',phone_number:'abc'},{type:'email',email:signupBody.email,phone_number:'9876543210'}])assert.equal((await send(body)).status,400);
  assert.equal((await request('/api/owner/auth/verify-otp','POST',{otp_token:'bad',otp:'1111'})).status,400);
  const emailOtp=await send({type:'email',email:signupBody.email});assert.equal(emailOtp.status,200);assert.match(emailOtp.data.otp_token,/^[a-f0-9]{64}$/);assert.equal(emailOtp.data.delivery,'development-fixed-otp');
  const token=emailOtp.data.otp_token,storedOtp=(await pool.query('SELECT * FROM public.owner_phone_verification WHERE otp_token=$1',[digest(token)])).rows[0];assert.equal(storedOtp.owner_id,undefined);assert.notEqual(storedOtp.otp,'1111');assert.notEqual(storedOtp.otp_token,token);
  assert.equal((await verify(token,'2222')).status,401);assert.equal((await pool.query('SELECT attempts FROM public.owner_phone_verification WHERE otp_token=$1',[digest(token)])).rows[0].attempts,1,'Failed OTP attempt persists');
  assert.equal((await verify(token)).status,200);assert.equal((await verify(token)).status,401,'Verification token is single-use');
  assert.equal((await pool.query('SELECT is_email_verified FROM public.owner WHERE owner_id=$1',[signupId])).rows[0].is_email_verified,true);
  const phoneOtp=await send({type:'phone',country_code:'+91',phone_number:signupBody.owner_phone_number});assert.equal((await verify(phoneOtp.data.otp_token)).status,200);assert.equal((await pool.query('SELECT is_phone_number_verified FROM public.owner WHERE owner_id=$1',[signupId])).rows[0].is_phone_number_verified,true);
  assert.equal((await reset(token,'Replacement-'+password)).status,401,'Verification challenge cannot reset password');
  const expired=await send({type:'email',email:'expiry@example.test'});await pool.query("UPDATE public.owner_phone_verification SET expires_at=now()-interval '1 second' WHERE otp_token=$1",[digest(expired.data.otp_token)]);assert.equal((await verify(expired.data.otp_token)).status,401);
  const exhausted=await send({type:'email',email:'attempts@example.test'});for(let i=0;i<4;i++)assert.equal((await verify(exhausted.data.otp_token,'2222')).status,401);assert.equal((await verify(exhausted.data.otp_token,'2222')).status,429);assert.equal((await verify(exhausted.data.otp_token)).status,429);
  const oldChallenge=await send({type:'email',email:'resend@example.test'});const freshChallenge=await send({type:'email',email:'resend@example.test'});assert.equal((await verify(oldChallenge.data.otp_token)).status,401);assert.equal((await verify(freshChallenge.data.otp_token)).status,200);
  const recovery=await forgot({type:'email',email:signupBody.email});assert.equal(recovery.status,200);const recoveryToken=recovery.data.otp_token;const replacement='Replacement-'+password;
  assert.equal((await reset(recoveryToken,replacement)).status,401,'Reset requires OTP verification');assert.equal((await verify(recoveryToken)).status,200);
  assert.equal((await request('/api/owner/auth/reset-password','POST',{otp_token:recoveryToken,new_password:replacement,confirm_password:'different'})).status,400);
  assert.equal((await reset(recoveryToken,replacement)).status,200);assert.equal((await reset(recoveryToken,replacement)).status,401);assert.equal((await me(sessionBeforeReset.cookie)).status,401);assert.equal((await login({email:signupBody.email,password})).status,401);assert.equal((await login({email:signupBody.email,password:replacement})).status,200);
  const unknownRecovery=await forgot({type:'email',email:'nonexistent@example.test'});assert.equal(unknownRecovery.status,200);assert.equal((await verify(unknownRecovery.data.otp_token)).status,200);assert.equal((await reset(unknownRecovery.data.otp_token,replacement)).status,401);
  const phoneRecovery=await forgot({type:'phone',country_code:'+91',phone_number:signupBody.owner_phone_number});assert.equal((await verify(phoneRecovery.data.otp_token)).status,200);assert.equal((await reset(phoneRecovery.data.otp_token,password)).status,200);assert.equal((await login({email:signupBody.email,password})).status,200);
  // A password change after issuance invalidates previously verified recovery proof.
  const stale=await forgot({type:'email',email:signupBody.email});await verify(stale.data.otp_token);await pool.query('UPDATE public.owner SET password=$1 WHERE owner_id=$2',[await hashPassword('Direct-change-'+password),signupId]);assert.equal((await reset(stale.data.otp_token,replacement)).status,401);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='owner_phone_verification' AND column_name='owner_id'")).rows[0].n,0);
  assert.equal((await request('/api/owner/auth/send-otp','POST',{type:'email',email:'origin@example.test'},undefined,{origin:'https://evil.example'})).status,403);
  await pool.query('DELETE FROM public.owner_otp_limits');
  for(let i=0;i<5;i++)assert.equal((await send({type:'email',email:'limited@example.test'})).status,200);assert.equal((await send({type:'email',email:'limited@example.test'})).status,429);
  process.env.NODE_ENV='production';try{assert.equal((await send({type:'email',email:'prod@example.test'})).status,503);assert.equal((await verify('a'.repeat(64))).status,503);}finally{process.env.NODE_ENV='test';}
  // Explicit URL points only to the required fresh disposable test DB.
  for(const table of ['owner_phone_verification','owner_otp_limits','owner_sessions','owner_login_attempts','owner','admin_sessions','admin','roles','modules','admin_login_attempts'])await pool.query('DELETE FROM public.'+table);
});
