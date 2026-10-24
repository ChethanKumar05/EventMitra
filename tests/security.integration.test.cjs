const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');

// Never reuse the developer database. The URL must name an expendable *_test database.
const url = process.env.TEST_DATABASE_URL;
test('PostgreSQL security API integration', { skip: !url && 'Set TEST_DATABASE_URL to an isolated database ending in _test' }, async t => {
  assert.match(new URL(url).pathname, /_test$/);
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
  const { pool } = require('../dist/config/database');
  const { runMigrations } = require('../dist/migrations/runMigrations');
  const { hashPassword, verifyPassword } = require('../dist/security/password');
  const { generateId } = require('../dist/utils/id');
  let server, seeded = false, venueOwnerId;
  t.after(async () => {
    if(server) await new Promise(resolve => server.close(resolve));
    try { if (venueOwnerId) {
      await pool.query('DELETE FROM public.venue_details WHERE owner_id=$1',[venueOwnerId]);
      await pool.query('DELETE FROM public.owner WHERE owner_id=$1',[venueOwnerId]);
    }
    if (seeded) {
      for (const table of ['admin_sessions','admin_permission','admin','role_permissions','permissions','roles','modules','admin_login_attempts']) await pool.query('DELETE FROM public.' + table);
    } } finally { await pool.end(); }
  });
  assert.equal((await pool.query("SELECT to_regclass('public.admin') AS existing")).rows[0].existing, null, 'Use a fresh empty test database (or npm run test:integration:local)');
  // Simulate an existing installation before migration 008, including legacy codes/grants.
  const upgrade = await pool.connect();
  await upgrade.query('BEGIN');
  try {
    await require('../dist/migrations/001_admin_migration').adminMigration(upgrade);
    await require('../dist/migrations/007_security_migration').securityMigration(upgrade);
    await upgrade.query("INSERT INTO public.roles(role_id,role_code,role_type) VALUES ('legacy-role','RL00041','Legacy')");
    await upgrade.query("INSERT INTO public.admin(admin_id,admin_code,admin_name,role_id) VALUES ('legacy-admin','ADM00027','Legacy','legacy-role')");
    await upgrade.query("INSERT INTO public.permissions(permission_id,permission_code,permission_name) VALUES ('legacy-permission','security.admins.read','Read admins'), ('numbered-permission','PER00009','Numbered')");
    await upgrade.query("INSERT INTO public.role_permissions(role_id,permission_id) VALUES ('legacy-role','legacy-permission')");
    await require('../dist/migrations/008_security_codes_migration').securityCodesMigration(upgrade);
    assert.equal((await upgrade.query("SELECT admin_code FROM public.admin WHERE admin_id='legacy-admin'")).rows[0].admin_code,'ADM00027');
    assert.equal((await upgrade.query("SELECT permission_key FROM public.permissions WHERE permission_id='legacy-permission'")).rows[0].permission_key,'security.admins.read');
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM public.role_permissions")).rows[0].n,1);
    assert.equal((await upgrade.query("INSERT INTO public.roles(role_id,role_type) VALUES ('next-role','Next') RETURNING role_code")).rows[0].role_code,'RL00042');
    assert.equal((await upgrade.query("INSERT INTO public.admin(admin_id,admin_name,role_id) VALUES ('next-admin','Next','next-role') RETURNING admin_code")).rows[0].admin_code,'ADM00028');
    assert.equal((await upgrade.query("INSERT INTO public.permissions(permission_id,permission_name,permission_key) VALUES ('next-permission','Next','next.read') RETURNING permission_code")).rows[0].permission_code,'PER00010');
    await upgrade.query("SELECT setval('public.role_code_seq',99999,false)");
    assert.equal((await upgrade.query("INSERT INTO public.roles(role_id,role_type) VALUES ('last-five','Boundary') RETURNING role_code")).rows[0].role_code,'RL99999');
    assert.equal((await upgrade.query("INSERT INTO public.roles(role_id,role_type) VALUES ('first-six','Boundary') RETURNING role_code")).rows[0].role_code,'RL100000');
    await upgrade.query("INSERT INTO public.modules(module_id,module_code,module_name) VALUES ('legacy-module','OLDMOD','Old module')");
    await upgrade.query("INSERT INTO public.admin_permission(admin_id,role_id,module_id,\"view\") VALUES ('legacy-admin','next-role','legacy-module',true)");
    await require('../dist/migrations/009_admin_module_permissions_migration').adminModulePermissionsMigration(upgrade);
    const migrated=(await upgrade.query(`SELECT ap.* FROM public.admin_permission ap JOIN public.modules m USING(module_id) WHERE ap.admin_id='legacy-admin' AND m.module_key='admin_management'`)).rows[0];
    assert.equal(migrated.role_id,'legacy-role'); assert.equal(migrated.read,true); assert.equal(migrated.view,true);
    assert.ok(migrated.permission_id); assert.match(migrated.permission_code,/^PER[0-9]{5,}$/);
    assert.equal((await upgrade.query("SELECT count(*)::int AS n FROM public.admin_permission WHERE module_id='legacy-module'")).rows[0].n,1,'Historical stale row is preserved');
    const legacyEffective=await require('../dist/services/adminPermissionService').effectivePermissions({admin_id:'legacy-admin',role_id:'legacy-role',is_super_admin:false},upgrade);
    assert.equal(legacyEffective.find(row=>row.module_id==='legacy-module').view,false,'Stale role never grants access');
    const migration10=require('../dist/migrations/010_admin_identity_validation_migration').adminIdentityValidationMigration;
    await assert.rejects(migration10(upgrade),/Duplicate role_type/);
    await upgrade.query("UPDATE public.roles SET role_type='Boundary six' WHERE role_id='first-six'");
    await upgrade.query("INSERT INTO public.modules(module_id,module_name,module_key) VALUES ('duplicate-name','  Old   module  ','duplicate_old')");
    await assert.rejects(migration10(upgrade),/Duplicate module_name/);
    await upgrade.query("DELETE FROM public.modules WHERE module_id='duplicate-name'");
    await migration10(upgrade);
    assert.equal((await upgrade.query("SELECT admin_username FROM public.admin WHERE admin_id='legacy-admin'")).rows[0].admin_username,'adm00027');
    await require('../dist/migrations/003_owner_migration').ownerMigration(upgrade);
    await upgrade.query(`INSERT INTO public.owner(owner_id,owner_code,country_code,owner_phone_number,owner_name,password) VALUES
      ('old-owner','OWN00020','+91','9000000001','Legacy Owner','old-hash'),('old-owner-2','OWN00021','+91','9000000002',' legacy  OWNER ','old-hash')`);
    await upgrade.query(`INSERT INTO public.owner_phone_verification(otp_id,owner_id,otp,is_verified,expires_at) VALUES ('old-otp','old-owner','old-otp-hash',true,now()+interval '1 hour')`);
    await require('../dist/migrations/011_owner_auth_migration').ownerAuthMigration(upgrade);
    const signupMigration=require('../dist/migrations/012_owner_signup_otp_migration').ownerSignupOtpMigration;
    await assert.rejects(signupMigration(upgrade),/Rename duplicate owner_name/);
    await upgrade.query("UPDATE public.owner SET owner_name='Second legacy owner' WHERE owner_id='old-owner-2'");
    await signupMigration(upgrade);
    const migratedOtp=(await upgrade.query("SELECT *,expires_at<=now() AS expired FROM public.owner_phone_verification WHERE otp_id='old-otp'")).rows[0];
    assert.equal(migratedOtp.owner_id,undefined);assert.equal(migratedOtp.phone_number,'9000000001');assert.equal(migratedOtp.country_code,'+91');assert.equal(migratedOtp.expired,true);assert.ok(migratedOtp.consumed_at);assert.match(migratedOtp.otp_token,/^[a-f0-9]{64}$/);
    assert.equal((await upgrade.query(`INSERT INTO public.owner(owner_id,country_code,owner_phone_number,owner_name,password) VALUES ('after-signup-migration','+91','9000000003','Third legacy owner','old-hash') RETURNING owner_code`)).rows[0].owner_code,'OWN00022');
  } finally { await upgrade.query('ROLLBACK'); upgrade.release(); }
  await runMigrations();
  const existing = await pool.query('SELECT count(*)::int AS n FROM public.admin');
  assert.equal(existing.rows[0].n, 0, 'Integration database must have no admins');
  const suffix = randomUUID().slice(0,8);
  let roleId, adminId;
  const password = 'Integration-only-password!';
  const hashed = await hashPassword(password);
  assert.notEqual(hashed, password);
  assert.equal(await verifyPassword(password,hashed),true);
  assert.equal(await verifyPassword('wrong',hashed),false);
  seeded = true;
  const { bootstrapSuperAdmin } = require('../dist/services/adminAuthService');
  const { renderBootstrapSql } = require('../dist/utils/bootstrapSql');
  const sqlTemplate = require('node:fs').readFileSync(require('node:path').join(__dirname,'../docs/sql/bootstrap-super-admin.sql'),'utf8');
  const bootstrapName = "Test admin O'Connor \\ $eventmitra_bootstrap$ __ADMIN_EMAIL__";
  await assert.rejects(pool.query(sqlTemplate), /Supply your own valid email/);
  const bootstrapSql = renderBootstrapSql(sqlTemplate,{name:bootstrapName,email:suffix+'@example.test',passwordHash:hashed});
  await pool.query(bootstrapSql);
  const bootstrapAccount=(await pool.query('SELECT admin_name,password_hash FROM public.admin')).rows[0];
  assert.equal(bootstrapAccount.admin_name,bootstrapName,'Generated SQL preserves quotes, backslashes, dollar tags and placeholder-like input');
  assert.equal(bootstrapAccount.password_hash,hashed);
  await assert.rejects(pool.query(bootstrapSql), /super admin already exists/i);
  await assert.rejects(pool.query(renderBootstrapSql(sqlTemplate,{name:'Invalid hash',email:'invalid@example.test',passwordHash:'not-a-hash'})), /Supply a hash/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.admin')).rows[0].n,1,'Failed/repeated SQL bootstrap does not add accounts');
  const bootstrapped = (await pool.query('SELECT admin_id,role_id,admin_code,admin_username FROM public.admin')).rows[0];
  adminId = bootstrapped.admin_id; roleId = bootstrapped.role_id;
  assert.equal(bootstrapped.admin_code,'ADM00001');
  assert.equal((await pool.query('SELECT role_code FROM public.roles WHERE role_id=$1',[roleId])).rows[0].role_code,'RL00001');
  await assert.rejects(bootstrapSuperAdmin({name:'Duplicate',email:'duplicate@example.test',password}),/already exists/);
  const { app } = require('../dist/app');
  server = app.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  async function request(path, method='GET', body, cookie, extra={}) {
    const res = await fetch(base+path,{method,headers:{...(body ? {'Content-Type':'application/json'} : {}),...(cookie ? {cookie} : {}),...extra},body:body ? JSON.stringify(body) : undefined});
    return { status:res.status, data:(await res.json()).data, cookie:res.headers.get('set-cookie')?.split(';')[0], headers:res.headers };
  }
  const login = (email,password) => request('/auth/login','POST',{email,password});
  assert.equal((await request('/admins')).status,401);
  assert.equal((await login(`${suffix}@example.test`,'wrong')).status,401);
  const logged = await login(`${suffix.toUpperCase()}@EXAMPLE.TEST`,password);
  assert.equal(logged.status,200); assert.match(logged.headers.get('set-cookie'),/HttpOnly/i); assert.match(logged.headers.get('set-cookie'),/SameSite=Strict/i);
  let cookie = logged.cookie;
  assert.equal((await request('/auth/me','GET',null,cookie)).data.admin_id,adminId);
  assert.equal((await request('/roles','POST',{role_code:'blocked',role_type:'Blocked'},cookie,{origin:'https://evil.example'})).status,403);
  const roles = await request('/roles','POST',{role_type:'Reader'},cookie);
  assert.equal(roles.status,201); assert.equal(roles.data.role_code,'RL00002'); const readerRole = roles.data.role_id;
  const permission = await request('/permissions','POST',{permission_key:'security.admins.read',permission_name:'Read admins'},cookie);
  assert.equal(permission.status,201); assert.equal(permission.data.permission_code,'PER00001'); const permissionId = permission.data.permission_id;
  assert.equal((await request('/permissions/'+permissionId,'PUT',{permission_name:'Read team'},cookie)).status,200);
  assert.equal((await request('/permissions/'+permissionId,'GET',null,cookie)).data.permission_name,'Read team');
  assert.equal((await request('/roles/'+readerRole,'PUT',{permission_ids:[permissionId]},cookie)).status,200);
  assert.deepEqual((await request('/roles/'+readerRole,'GET',null,cookie)).data.permission_ids,[permissionId]);
  const created = await request('/admins','POST',{admin_name:'Reader',admin_username:'reader_'+suffix,admin_email:`reader-${suffix}@example.test`,password,role_id:readerRole,department:'Finance',admin_phone_number:'9000000001'},cookie);
  assert.equal(created.status,201); assert.equal(created.data.admin_code,'ADM00002'); assert.equal(created.data.password_hash,undefined); const readerId = created.data.admin_id;
  const list = await request('/admins?page=1&limit=1','GET',null,cookie);
  assert.equal(list.data.items.length,1); assert.equal(list.data.total,2); assert.equal(list.data.items[0].password_hash,undefined);
  // Search, combined filters, relation filters and filtered page metadata.
  const listRequest = async (resource, query) => request('/'+resource+'?'+new URLSearchParams(query),'GET',null,cookie);
  const filtered = await listRequest('admins',{search:'READER',status:'active',role_id:readerRole,is_super_admin:'false',limit:'1'});
  assert.equal(filtered.status,200);
  assert.deepEqual({total:filtered.data.total,totalPages:filtered.data.totalPages,hasNextPage:filtered.data.hasNextPage,hasPreviousPage:filtered.data.hasPreviousPage},{total:1,totalPages:1,hasNextPage:false,hasPreviousPage:false});
  assert.equal(filtered.data.items[0].admin_id,readerId);
  assert.equal((await listRequest('admins',{admin_code:'adm00002'})).data.total,1);
  assert.equal((await listRequest('admins',{is_super_admin:'true'})).data.items[0].admin_id,adminId);
  assert.equal((await listRequest('admins',{search:'READER',is_super_admin:'true'})).data.total,0);
  assert.equal((await listRequest('admins',{search:'reader-'+suffix+'@example.test'})).data.total,1);
  assert.equal((await listRequest('admins',{status:'block'})).data.total,0);
  const firstPage = await listRequest('admins',{limit:'1'});
  const secondPage = await listRequest('admins',{page:'2',limit:'1'});
  assert.equal(firstPage.data.totalPages,2); assert.equal(firstPage.data.hasNextPage,true);
  assert.equal(secondPage.data.hasPreviousPage,true); assert.equal(secondPage.data.hasNextPage,false);
  assert.notEqual(firstPage.data.items[0].admin_id,secondPage.data.items[0].admin_id);
  const beyond = await listRequest('admins',{search:'reader',page:'2',limit:'1'});
  assert.deepEqual(beyond.data.items,[]); assert.equal(beyond.data.total,1);
  assert.equal((await listRequest('roles',{search:'READER',permission_id:permissionId,role_code:'rl00002'})).data.total,1);
  assert.equal((await listRequest('roles',{permission_id:permissionId})).data.items[0].role_id,readerRole);
  assert.equal((await listRequest('roles',{role_type:'reader'})).data.total,1);
  assert.equal((await listRequest('roles',{role_code:'RL00001',permission_id:permissionId})).data.total,0);
  assert.equal((await listRequest('permissions',{search:'TEAM',permission_key:'SECURITY.ADMINS.READ',role_id:readerRole,permission_code:'per00001'})).data.total,1);
  assert.equal((await listRequest('permissions',{role_id:roleId})).data.total,0);
  for(const resource of ['admins','roles','permissions']) {
    const empty = await listRequest(resource,{search:'no-match-'+suffix});
    assert.equal(empty.status,200); assert.equal(empty.data.total,0); assert.equal(empty.data.totalPages,0); assert.deepEqual(empty.data.items,[]);
    assert.equal((await listRequest(resource,{search:"' OR 1=1 --"})).data.total,0);
    assert.equal((await request('/'+resource+'?search=x&search=y','GET',null,cookie)).status,400);
    assert.equal((await request('/'+resource+'?search[nested]=x','GET',null,cookie)).status,400);
    assert.equal((await listRequest(resource,{search:'x'.repeat(201)})).status,400);
    assert.equal((await listRequest(resource,{unknown:'value'})).status,400);
    assert.equal((await listRequest(resource,{limit:'101'})).status,400);
  }
  assert.equal((await listRequest('admins',{is_super_admin:'yes'})).status,400);
  assert.equal((await listRequest('admins',{status:'pending'})).status,400);
  assert.equal((await listRequest('admins',{role_id:'x'.repeat(27)})).status,400);
  await request('/roles/'+readerRole,'PUT',{role_type:'Reader%_\\Team'},cookie);
  for(const search of ['%','_','\\']) assert.equal((await listRequest('roles',{search})).data.total,1,'Search characters are literal');
  await request('/roles/'+readerRole,'PUT',{role_type:'Reader'},cookie);

  // Public venue filters must never expose inactive or pending records.
  venueOwnerId = generateId();
  await pool.query(`INSERT INTO public.owner(owner_id,owner_code,country_code,owner_phone_number,owner_name,password)
    VALUES ($1,$1,'+91','9000000000','Venue fixture',$2)`,[venueOwnerId,hashed]);
  const venueIds=[];
  for(const [name,city,state,area,capacity,status,active] of [
    ['Garden%_ Hall','Bengaluru','Karnataka','Indiranagar',250,'Active',true],
    ['Garden Large','Bengaluru','Karnataka','Whitefield',500,'Active',true],
    ['Garden Chennai','Chennai','Tamil Nadu','Central',300,'Active',true],
    ['Garden Hidden','Bengaluru','Karnataka','Indiranagar',250,'Pending',true],
    ['Garden Inactive','Bengaluru','Karnataka','Indiranagar',250,'Active',false]
  ]) {
    const id=generateId(); venueIds.push(id);
    await pool.query(`INSERT INTO public.venue_details(venue_id,venue_code,owner_id,venue_name,city,state,area,venue_hall_capacity,status,is_active)
      VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,venueOwnerId,name,city,state,area,capacity,status,active]);
  }
  async function venues(query) {
    const response=await fetch(base.replace('/api/admin','/api/venues')+'?'+new URLSearchParams(query));
    return {status:response.status,data:(await response.json()).data};
  }
  const publicList=await venues({search:'GARDEN',city:'bengaluru',state:'karnataka',min_capacity:'200',max_capacity:'300'});
  assert.equal(publicList.status,200); assert.equal(publicList.data.total,1); assert.equal(publicList.data.items[0].venue_id,venueIds[0]);
  assert.equal((await venues({area:'indiranagar'})).data.total,1);
  assert.equal((await venues({owner_id:venueOwnerId})).data.total,3);
  assert.equal((await venues({venue_code:venueIds[0].toLowerCase()})).data.total,1);
  assert.equal((await venues({search:'%_'})).data.total,1);
  assert.equal((await venues({search:"' OR 1=1 --"})).data.total,0);
  const vp1=await venues({limit:'1'}), vp2=await venues({page:'2',limit:'1'});
  assert.equal(vp1.data.total,3); assert.equal(vp1.data.totalPages,3); assert.equal(vp1.data.hasNextPage,true);
  assert.notEqual(vp1.data.items[0].venue_id,vp2.data.items[0].venue_id);
  assert.equal((await venues({city:'Unknown'})).data.total,0);
  assert.deepEqual((await venues({page:'9'})).data.items,[]);
  for(const query of [{status:'Pending'},{min_capacity:'-1'},{min_capacity:'301',max_capacity:'300'},{min_capacity:'1.5'},{page:'0'},{limit:'101'}]) {
    assert.equal((await venues(query)).status,400);
  }
  assert.equal((await fetch(base.replace('/api/admin','/api/venues')+'?city=x&city=y')).status,400);
  assert.equal((await request('/admins?page=0','GET',null,cookie)).status,400);
  assert.equal((await request('/admins/missing','GET',null,cookie)).status,404);
  assert.equal((await request('/admins/'+adminId,'DELETE',null,cookie)).status,409);
  assert.equal((await request('/admins/'+adminId,'PUT',{status:'block'},cookie)).status,409);
  assert.equal((await request('/admins/'+adminId,'PUT',{is_super_admin:false},cookie)).status,409);
  assert.equal((await request('/permissions','POST',{permission_key:'security.admins.read',permission_name:'Duplicate'},cookie)).status,409);
  assert.equal((await request('/roles/'+readerRole,'PUT',{permission_ids:['nonexistent']},cookie)).status,409);
  assert.deepEqual((await request('/roles/'+readerRole,'GET',null,cookie)).data.permission_ids,[permissionId], 'Failed assignment replacement rolls back');
  assert.equal((await request('/admins','POST',{admin_name:'Weak',admin_username:'weak',admin_email:'weak@example.test',password:'short',role_id:readerRole},cookie)).status,400);
  for (const [resource, code, payload] of [
    ['admins','admin_code',{admin_code:'ADM99999'}],
    ['roles','role_code',{role_code:'RL99999',role_type:'Manual'}],
    ['permissions','permission_code',{permission_code:'PER99999',permission_key:'manual.read',permission_name:'Manual'}]
  ]) {
    assert.equal((await request('/'+resource,'POST',payload,cookie)).status,400,code+' cannot be supplied');
    const id = resource === 'admins' ? readerId : resource === 'roles' ? readerRole : permissionId;
    assert.equal((await request('/'+resource+'/'+id,'PUT',payload,cookie)).status,400,code+' cannot be updated');
  }
  assert.equal((await request('/roles','POST',{role_type:null},cookie)).status,400);
  assert.equal((await request('/permissions','POST',{permission_key:'INVALID KEY',permission_name:'Bad'},cookie)).status,400);
  assert.equal((await request('/roles/'+readerRole,'PUT',{permission_ids:[null]},cookie)).status,400);
  assert.equal((await request('/admins?page[]=1','GET',null,cookie)).status,400);
  const parallelRoles = await Promise.all(Array.from({length:6},(_,i) => request('/roles','POST',{role_type:'Concurrent '+i},cookie)));
  assert.ok(parallelRoles.every(r => r.status === 201));
  const codes = parallelRoles.map(r => r.data.role_code);
  assert.equal(new Set(codes).size,6);
  codes.forEach(code => assert.match(code,/^RL[0-9]{5,}$/));
  const maxCode = Math.max(...codes.map(code => Number(code.slice(2))));
  for (const r of parallelRoles) assert.equal((await request('/roles/'+r.data.role_id,'DELETE',null,cookie)).status,200);
  const afterDelete = await request('/roles','POST',{role_type:'After delete'},cookie);
  assert.ok(Number(afterDelete.data.role_code.slice(2)) > maxCode,'Deleted codes are not reused');
  assert.equal((await request('/roles/'+afterDelete.data.role_id,'DELETE',null,cookie)).status,200);
  assert.equal((await request('/admins/'+readerId,'GET',null,cookie)).data.admin_code,'ADM00002');
  assert.equal((await request('/roles/'+readerRole,'GET',null,cookie)).data.role_code,'RL00002');
  assert.equal((await request('/permissions/'+permissionId,'GET',null,cookie)).data.permission_code,'PER00001');
  // Required fields, login identifiers, format validation and unique identities/names.
  const validAdmin={admin_name:'Validation account',admin_username:'validation_'+suffix,admin_email:'validation-'+suffix+'@example.test',password,role_id:readerRole};
  for(const field of ['admin_name','admin_username','admin_email','password','role_id']) {
    const invalid={...validAdmin};delete invalid[field];
    assert.equal((await request('/admins','POST',invalid,cookie)).status,400,'Required '+field);
  }
  for(const value of ['with space',' leading','trailing ','tab\tname','short@name','xy',123])assert.equal((await request('/admins','POST',{...validAdmin,admin_username:value},cookie)).status,400);
  for(const value of ['bad','a..b@example.test','a@-domain.test','a@domain..test',123])assert.equal((await request('/admins','POST',{...validAdmin,admin_email:value},cookie)).status,400);
  for(const value of ['abc','123','123 4567890','+1234567890123456','0000000',9000000001])assert.equal((await request('/admins','POST',{...validAdmin,admin_phone_number:value},cookie)).status,400);
  assert.equal((await request('/admins','POST',{...validAdmin,admin_username:('reader_'+suffix).toUpperCase()},cookie)).status,409);
  assert.equal((await request('/admins','POST',{...validAdmin,admin_email:('reader-'+suffix+'@example.test').toUpperCase()},cookie)).status,409);
  assert.equal((await request('/admins','POST',{...validAdmin,admin_phone_number:'9000000001'},cookie)).status,409);
  assert.equal((await request('/admins','POST',{...validAdmin,role_id:'missing'},cookie)).status,409);
  assert.equal((await request('/admins/'+readerId,'PUT',{admin_username:'with space'},cookie)).status,400);
  assert.equal((await request('/admins/'+readerId,'PUT',{admin_username:bootstrapped.admin_username.toUpperCase()},cookie)).status,409);
  assert.equal((await request('/roles','POST',{role_type:' reader '},cookie)).status,409);
  assert.equal((await request('/roles/'+readerRole,'PUT',{role_type:'super   admin'},cookie)).status,409);
  assert.equal((await request('/roles','POST',{},cookie)).status,400);
  assert.equal((await request('/modules','POST',{module_name:'  admin   management  ',module_key:'different_key'},cookie)).status,409);
  assert.equal((await request('/modules','POST',{module_name:'Different name',module_key:'admin_management'},cookie)).status,409);
  assert.equal((await request('/modules','POST',{},cookie)).status,400);
  assert.equal((await request('/auth/login','POST',{username:('reader_'+suffix).toUpperCase(),password})).status,200);
  const identifierLogin=await request('/auth/login','POST',{identifier:'reader_'+suffix,password});assert.equal(identifierLogin.status,200);assert.equal(identifierLogin.data.admin_username,'reader_'+suffix);
  assert.equal((await request('/auth/login','POST',{username:'with space',password})).status,400);
  assert.equal((await request('/auth/login','POST',{email:suffix+'@example.test',username:bootstrapped.admin_username,password})).status,400);
  assert.equal((await request('/auth/login','POST',{password})).status,400);
  assert.equal((await request('/admins?admin_username=READER_'+suffix+'&search_column=admin_username&search=reader','GET',null,cookie)).data.total,1);
  const validPhone=await request('/admins','POST',{...validAdmin,admin_phone_number:'+919876543210'},cookie);assert.equal(validPhone.status,201);
  assert.equal((await request('/admins/'+validPhone.data.admin_id,'DELETE',null,cookie)).status,200);
  const duplicateRoles=await Promise.all([0,1].map(()=>request('/roles','POST',{role_type:'Concurrent duplicate'},cookie)));
  assert.deepEqual(duplicateRoles.map(result=>result.status).sort(),[201,409]);
  await request('/roles/'+duplicateRoles.find(result=>result.status===201).data.role_id,'DELETE',null,cookie);
  // Main-module CRUD, per-admin grants, sorting and column-specific search.
  assert.equal((await request('/admins?search=finance&search_column=department','GET',null,cookie)).data.total,1);
  assert.equal((await request('/admins?search=finance&search_column=admin_name','GET',null,cookie)).data.total,0);
  assert.equal((await request('/admins?search=reader&search_column=role_type&department=Finance&admin_phone_number=9000000001','GET',null,cookie)).data.total,1);
  const sortedAsc=(await request('/admins?sort_by=admin_name&sort_order=asc','GET',null,cookie)).data.items;
  const sortedDesc=(await request('/admins?sort_by=admin_name&sort_order=desc','GET',null,cookie)).data.items;
  assert.deepEqual(sortedAsc.map(row=>row.admin_id).reverse(),sortedDesc.map(row=>row.admin_id));
  for(const query of ['sort_by=password_hash','sort_order=sideways','search_column=password_hash','sort_by=admin_name;DROP TABLE admin']) assert.equal((await request('/admins?'+query,'GET',null,cookie)).status,400);
  const modules=(await request('/modules?limit=100','GET',null,cookie)).data.items;
  const adminModule=modules.find(row=>row.module_key==='admin_management');
  assert.equal(modules.length,4); assert.ok(modules.every(row=>/^MOD[0-9]{5,}$/.test(row.module_code)));
  assert.equal((await request('/modules/'+adminModule.module_id,'GET',null,cookie)).status,200);
  assert.equal((await request('/modules/'+adminModule.module_id,'PUT',{module_key:'renamed'},cookie)).status,409);
  assert.equal((await request('/modules/'+adminModule.module_id,'DELETE',null,cookie)).status,409);
  assert.equal((await request('/modules','POST',{module_name:'Sub',parent_module_id:adminModule.module_id},cookie)).status,400);
  const customModule=await request('/modules','POST',{module_name:'Owner Management'},cookie);assert.equal(customModule.status,201);
  const ownerModuleId=customModule.data.module_id; assert.equal(customModule.data.module_key,'owner_management');
  assert.equal((await request('/modules/'+ownerModuleId,'PUT',{module_name:'Owner Management Updated'},cookie)).status,200);
  assert.equal((await request('/modules?search_column=module_key&search=owner_management&sort_by=module_name&sort_order=desc','GET',null,cookie)).data.total,1);
  const grant=await request('/admin-permissions','POST',{admin_id:readerId,role_id:readerRole,module_id:adminModule.module_id,read:true,view:true},cookie);
  assert.equal(grant.status,200);assert.match(grant.data.permission_code,/^PER[0-9]{5,}$/);const grantId=grant.data.permission_id;
  assert.equal((await pool.query('SELECT role_id FROM public.admin_permission WHERE permission_id=$1',[grantId])).rows[0].role_id,readerRole);
  assert.equal((await request('/admin-permissions','POST',{admin_id:readerId,role_id:readerRole,module_id:adminModule.module_id,all:true},cookie)).status,200);
  assert.equal((await request('/admin-permissions','POST',{admin_id:readerId,role_id:roleId,module_id:ownerModuleId,read:true},cookie)).status,409);
  assert.equal((await request('/admin-permissions','POST',{admin_id:readerId,role_id:readerRole,module_id:'missing',read:true},cookie)).status,409);
  assert.equal((await request('/admin-permissions','POST',{admin_id:readerId,role_id:readerRole,module_id:adminModule.module_id,read:'yes'},cookie)).status,400);
  assert.equal((await request('/admin-permissions','POST',{admin_id:readerId,role_id:readerRole,module_id:adminModule.module_id,permission_code:'PER99999'},cookie)).status,400);
  assert.equal((await request('/admin-permissions?admin_id='+readerId+'&read=true&sort_by=module_name&sort_order=asc','GET',null,cookie)).data.total,1);
  assert.equal((await request('/admin-permissions?search=reader&search_column=admin_name','GET',null,cookie)).data.total,1);
  // The same POST supports object or array upserts with stable IDs and atomic batches.
  const repeated=await request('/admin-permissions','POST',{admin_id:readerId,role_id:readerRole,module_id:adminModule.module_id,edit:false},cookie);
  assert.equal(repeated.status,200);assert.equal(repeated.data.permission_id,grantId);assert.equal(repeated.data.read,true,'Omitted flags are preserved');
  const batch=await request('/admin-permissions','POST',[
    {admin_id:readerId,role_id:readerRole,module_id:adminModule.module_id,all:false,edit:false,delete:false,create:false,read:true,view:true},
    {admin_id:readerId,role_id:readerRole,module_id:ownerModuleId,read:true}
  ],cookie);
  assert.equal(batch.status,200);assert.equal(batch.data.length,2);assert.equal(batch.data[0].permission_id,grantId);
  const newOwnerId=batch.data[1].permission_id;
  assert.equal((await request('/admin-permissions','POST',[
    {admin_id:readerId,role_id:readerRole,module_id:adminModule.module_id,read:false},
    {admin_id:readerId,role_id:readerRole,module_id:'missing',read:true}
  ],cookie)).status,409);
  assert.equal((await request('/admin-permissions/'+grantId,'GET',null,cookie)).data.read,true,'Batch failure rolls back earlier rows');
  assert.equal((await request('/admin-permissions','POST',[],cookie)).status,400);
  assert.equal((await request('/admin-permissions','POST',[{admin_id:readerId,module_id:ownerModuleId,read:true}],cookie)).status,400);
  assert.equal((await request('/admin-permissions','POST',[{admin_id:readerId,role_id:readerRole,module_id:ownerModuleId},{admin_id:readerId,role_id:readerRole,module_id:ownerModuleId}],cookie)).status,400);
  assert.equal((await request('/admin-permissions/'+grantId,'PUT',{read:true},cookie)).status,404,'No separate update endpoint');
  const concurrentGrants=await Promise.all([0,1].map(()=>request('/admin-permissions','POST',{admin_id:readerId,role_id:readerRole,module_id:ownerModuleId,view:true},cookie)));
  assert.ok(concurrentGrants.every(result=>result.status===200&&result.data.permission_id===newOwnerId));
  const bulk=await request('/admins/'+readerId+'/permissions','PUT',{role_id:readerRole,permissions:[{module_id:adminModule.module_id,read:true,view:true},{module_id:ownerModuleId,all:true}]},cookie);
  assert.equal(bulk.status,200);assert.equal(bulk.data.permissions.find(row=>row.module_id===adminModule.module_id).permission_id,grantId,'Matrix saves preserve assignment IDs');
  const ownerGrant=bulk.data.permissions.find(row=>row.module_id===ownerModuleId);
  for(const action of ['all','read','view','create','edit','delete']) assert.equal(ownerGrant[action],true);
  assert.equal((await request('/admins/'+readerId+'/permissions','PUT',{role_id:roleId,permissions:[]},cookie)).status,409);
  assert.equal((await request('/admins/'+readerId+'/permissions','PUT',{role_id:readerRole,permissions:[{module_id:ownerModuleId},{module_id:ownerModuleId}]},cookie)).status,400);
  assert.equal((await request('/admins/'+readerId+'/permissions','PUT',{role_id:readerRole,permissions:[{module_id:'missing'}]},cookie)).status,409);
  assert.equal((await request('/admins/'+readerId+'/permissions','GET',null,cookie)).data.permissions.find(row=>row.module_id===ownerModuleId).all,true,'Failed matrix save leaves old grants intact');
  const expiring = await login(`${suffix}@example.test`,password);
  const { digest } = require('../dist/security/password');
  await pool.query("UPDATE public.admin_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[digest(expiring.cookie.split('=')[1])]);
  assert.equal((await request('/auth/me','GET',null,expiring.cookie)).status,401);
  const oldSession = await login(`reader-${suffix}@example.test`,password);
  const changedPassword = 'Changed-integration-password!';
  assert.equal((await request('/admins/'+readerId,'PUT',{password:changedPassword},cookie)).status,200);
  assert.equal((await request('/auth/me','GET',null,oldSession.cookie)).status,401);
  assert.equal((await login(`reader-${suffix}@example.test`,password)).status,401);
  const reader = await login(`reader-${suffix}@example.test`,changedPassword); assert.equal(reader.status,200);
  assert.equal((await request('/admins','GET',null,reader.cookie)).status,200);
  assert.equal((await request('/roles','GET',null,reader.cookie)).status,403);
  assert.equal((await request('/roles?search=Reader&role_code=RL00002','GET',null,reader.cookie)).status,403);
  for(const resource of ['admins','roles','permissions']) assert.equal((await request('/'+resource,'POST',{},reader.cookie)).status,403);
  assert.equal(reader.data.role_id,readerRole);
  assert.ok(reader.data.permissions.find(row=>row.module_key==='admin_management').read);
  assert.ok(reader.data.permissions.find(row=>row.module_key==='owner_management').all);
  for(const resource of ['modules','admin-permissions']) assert.equal((await request('/'+resource,'POST',{},reader.cookie)).status,403);
  assert.equal((await request('/admins/'+readerId+'/permissions','PUT',{role_id:readerRole,permissions:[]},reader.cookie)).status,403);
  await request('/admin-permissions','POST',{admin_id:readerId,role_id:readerRole,module_id:adminModule.module_id,read:false,view:false},cookie);
  assert.equal((await request('/admins','GET',null,reader.cookie)).status,403,'Permission revocation takes effect in the existing session');
  await request('/admin-permissions','POST',{admin_id:readerId,role_id:readerRole,module_id:adminModule.module_id,all:true},cookie);
  assert.equal((await request('/admins','GET',null,reader.cookie)).status,200);
  assert.equal((await request('/admins','POST',{},reader.cookie)).status,403,'All flags never grant security write access to non-super admins');
  await request('/admin-permissions','POST',{admin_id:readerId,role_id:readerRole,module_id:adminModule.module_id,all:false,create:false,edit:false,delete:false,read:true,view:true},cookie);
  assert.equal((await request('/admin-permissions/'+ownerGrant.permission_id,'DELETE',null,cookie)).status,200);
  assert.equal((await request('/admin-permissions/'+ownerGrant.permission_id,'GET',null,cookie)).status,404);
  assert.equal((await request('/auth/me','GET',null,reader.cookie)).data.permissions.find(row=>row.module_key==='owner_management').all,false);
  await request('/admin-permissions','POST',{admin_id:readerId,role_id:readerRole,module_id:ownerModuleId,all:true},cookie);
  assert.equal((await request('/modules/'+ownerModuleId,'DELETE',null,cookie)).status,200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.admin_permission WHERE module_id=$1',[ownerModuleId])).rows[0].n,0);
  assert.equal((await request('/admins/'+readerId,'PUT',{role_id:roleId},cookie)).status,200);
  assert.equal((await request('/auth/me','GET',null,reader.cookie)).status,401,'Role change invalidates old session');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.admin_permission WHERE admin_id=$1',[readerId])).rows[0].n,0,'Role change clears old grants');
  const afterRoleChange=await login('reader-'+suffix+'@example.test',changedPassword);
  assert.equal(afterRoleChange.status,200);assert.ok(afterRoleChange.data.permissions.every(row=>!row.read&&!row.view&&!row.all),'New role never inherits stale grants');
  assert.equal((await request('/admins','GET',null,afterRoleChange.cookie)).status,403);
  await request('/admins/'+readerId,'PUT',{role_id:readerRole},cookie);
  assert.equal((await request('/admins/'+readerId,'PUT',{status:'block'},cookie)).status,200);
  assert.equal((await request('/auth/me','GET',null,reader.cookie)).status,401);
  assert.equal((await listRequest('admins',{status:'block',role_id:readerRole})).data.total,1);
  assert.equal((await login(`reader-${suffix}@example.test`,password)).status,401);
  assert.equal((await request('/roles/'+readerRole,'DELETE',null,cookie)).status,409);
  assert.equal((await request('/admins/'+readerId,'DELETE',null,cookie)).status,200);
  assert.equal((await request('/roles/'+readerRole,'DELETE',null,cookie)).status,200);
  assert.equal((await request('/permissions/'+permissionId,'DELETE',null,cookie)).status,200);
  const throttleAdmin=await request('/admins','POST',{admin_name:'Throttle fixture',admin_username:'throttle_'+suffix,admin_email:'throttle-'+suffix+'@example.test',password,role_id:roleId},cookie);
  assert.equal(throttleAdmin.status,201);
  for(let i=0;i<10;i++)assert.equal((await request('/auth/login','POST',i%2?{username:'throttle_'+suffix,password:'wrong'}:{email:'throttle-'+suffix+'@example.test',password:'wrong'})).status,401);
  assert.equal((await request('/auth/login','POST',{identifier:'throttle_'+suffix,password})).status,429,'Email/username share the same attempt budget');
  await request('/admins/'+throttleAdmin.data.admin_id,'DELETE',null,cookie);
  // Two super admins demoting themselves concurrently leave one active.
  const second = await request('/admins','POST',{admin_name:'Second',admin_username:'second_'+suffix,admin_email:`second-${suffix}@example.test`,password,role_id:roleId,is_super_admin:true},cookie);
  const secondLogin = await login(`second-${suffix}@example.test`,password);
  const races = await Promise.all([
    request('/admins/'+adminId,'PUT',{is_super_admin:false},cookie),
    request('/admins/'+second.data.admin_id,'PUT',{is_super_admin:false},secondLogin.cookie)
  ]);
  assert.equal(races.filter(r => r.status === 200).length,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.admin WHERE status='active' AND is_super_admin")).rows[0].n,1);
  cookie = (await login(`${suffix}@example.test`,password)).cookie;
  assert.equal((await request('/auth/logout','POST',null,cookie)).status,200);
  assert.equal((await request('/auth/me','GET',null,cookie)).status,401);
  const staticBase = base.replace('/api/admin','/admin/');
  for (const asset of ['', 'app.js', 'style.css']) {
    const response = await fetch(staticBase + asset);
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);
    assert.ok((await response.text()).length > 100);
  }
  await runMigrations();
  for(let i=0;i<10;i++) assert.equal((await login('throttle@example.test','wrong')).status,401);
  assert.equal((await login('throttle@example.test','wrong')).status,429);
});
