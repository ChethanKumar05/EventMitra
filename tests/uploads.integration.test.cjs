const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {randomBytes}=require('node:crypto');
const url=process.env.UPLOAD_TEST_DATABASE_URL;

test('Shared authenticated S3 uploads over multipart HTTP',{skip:!url&&'Set UPLOAD_TEST_DATABASE_URL to a fresh isolated *_test database'},async t=>{
  assert.match(new URL(url).pathname,/_test$/);
  process.env.DATABASE_URL=url;process.env.NODE_ENV='test';
  delete process.env.AWS_S3_BUCKET;delete process.env.AWS_REGION;
  const {pool}=require('../dist/config/database');
  const {runMigrations}=require('../dist/migrations/runMigrations');
  const {generateId}=require('../dist/utils/id');
  const {hashPassword}=require('../dist/security/password');
  const {S3Client,PutObjectCommand}=require('@aws-sdk/client-s3');
  const originalSend=S3Client.prototype.send,calls=[];
  let server,failUpload=false;
  S3Client.prototype.send=async function(command){
    assert.ok(command instanceof PutObjectCommand,'Only object PUT requests reach the fake provider');
    calls.push(command.input);if(failUpload)throw new Error('Fake denied bucket');return {ETag:'fake-etag'};
  };
  t.after(async()=>{S3Client.prototype.send=originalSend;if(server)await new Promise(resolve=>server.close(resolve));await pool.end();});
  assert.equal((await pool.query("SELECT to_regclass('public.owner') AS existing")).rows[0].existing,null);
  await runMigrations();
  const password='Upload-test-'+randomBytes(16).toString('hex'),hash=await hashPassword(password),ownerId=generateId(),userId=generateId();
  await pool.query(`INSERT INTO public.owner(owner_id,owner_name,user_name,country_code,owner_phone_number,email,password)
    VALUES($1,'Upload Owner','upload_owner','+91','9876700001','upload-owner@example.test',$2)`,[ownerId,hash]);
  await pool.query(`INSERT INTO public."user"(user_id,user_name,country_code,user_phone_number,gender)
    VALUES($1,'Upload User','+91','9876700002','m')`,[userId]);
  await require('../dist/services/adminAuthService').bootstrapSuperAdmin({name:'Upload Admin',email:'upload-admin@example.test',password});
  const {app}=require('../dist/app');server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  async function json(path,body,cookie){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)});return {...await r.json(),status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const owner=await json('/api/owner/auth/login',{user_name:'UPLOAD_OWNER',password});assert.equal(owner.status,200);
  const admin=await json('/api/admin/auth/login',{email:'upload-admin@example.test',password});assert.equal(admin.status,200);
  const challenge=await json('/api/user/auth/login',{country_code:'+91',user_phone_number:'9876700002'});
  const user=await json('/api/user/auth/verify-otp',{otp_token:challenge.data.otp_token,otp:'1111'});assert.equal(user.status,200);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6KWUAAAAASUVORK5CYII=','base64');
  function form({bytes=png,type='image/png',name='image.png',folder='venues',extra,second=false}={}){
    const f=new FormData();f.append('file',new Blob([bytes],{type}),name);if(folder!==undefined)f.append('folder',folder);
    if(extra)f.append(extra[0],extra[1]);if(second)f.append('file',new Blob([png],{type:'image/png'}),'other.png');return f;
  }
  async function upload(body=form(),cookie=owner.cookie,headers={}){const r=await fetch(base+'/api/uploads',{method:'POST',headers:{...(cookie?{cookie}:{}),...headers},body});return {...await r.json(),status:r.status};}
  await t.test('Authentication precedes file parsing and ambiguous cookies require an explicit actor',async()=>{
    assert.equal((await upload(form(),null)).status,401);
    assert.equal((await upload(form(),owner.cookie,{origin:'https://evil.example'})).status,403);
    assert.equal((await upload(form(),owner.cookie+'; '+admin.cookie)).status,400);
    assert.equal((await upload(form(),null,{authorization:'Bearer wrong'})).status,401);
    assert.equal((await upload(form(),null,{authorization:'Bearer '+owner.data.access_token,'X-Actor-Type':'admin'})).status,401);
    assert.equal((await upload(form(),owner.cookie,{'X-Actor-Type':'anything'})).status,400);
    assert.equal(calls.length,0);
    assert.equal((await upload()).status,503,'No AWS configuration is reported without leaking credentials');
  });
  process.env.AWS_REGION='ap-south-1';process.env.AWS_S3_BUCKET='eventmitra-test-private';
  process.env.AWS_ACCESS_KEY_ID='fake-test-key';process.env.AWS_SECRET_ACCESS_KEY='fake-test-secret';
  await t.test('Admin, owner bearer and user cookies upload private objects under separate namespaces',async()=>{
    for(const [identity,cookie,headers,id]of [['owner',null,{authorization:'Bearer '+owner.data.access_token},ownerId],['user',user.cookie,{},userId],['admin',owner.cookie+'; '+admin.cookie,{'X-Actor-Type':'admin'},undefined]]){
      const result=await upload(form({name:'../../untrusted.png'}),cookie,headers);assert.equal(result.status,201,result.message);
      assert.match(result.data.key,new RegExp('^uploads/'+identity+'/'));
      if(id)assert.ok(result.data.key.startsWith(`uploads/${identity}/${id}/venues/`));
      assert.ok(!result.data.key.includes('untrusted'));assert.equal(result.data.size,png.length);assert.equal(result.data.content_type,'image/png');assert.equal(result.data.original_name,'untrusted.png');
      const preview=new URL(result.data.preview_url);assert.equal(preview.searchParams.get('X-Amz-Expires'),'600');assert.ok(preview.searchParams.get('X-Amz-Signature'));
      assert.ok(!result.data.url.includes('?'),'Stored object URL does not contain expiring credentials');
      const command=calls.at(-1);assert.equal(command.Bucket,process.env.AWS_S3_BUCKET);assert.equal(command.Key,result.data.key);assert.equal(command.ACL,undefined);assert.equal(command.ServerSideEncryption,'AES256');assert.equal(command.Metadata.actor_type,identity);assert.ok(command.Body.equals(png));
    }
    const repeat=await upload();assert.equal(repeat.status,201);assert.notEqual(calls[0].Key,repeat.data.key,'Repeated uploads never overwrite another object');
    const pdf=await upload(form({bytes:Buffer.from('%PDF-1.7\n%test'),type:'application/pdf',name:'document.pdf'}));assert.equal(pdf.status,201);assert.match(calls.at(-1).ContentDisposition,/^attachment/);
  });
  await t.test('Multipart, size, file signatures and folder boundaries are checked before S3',async()=>{
    const before=calls.length;
    assert.equal((await upload(JSON.stringify({file:'fake'}),owner.cookie,{'Content-Type':'application/json'})).status,415);
    assert.equal((await upload(new FormData())).status,400);
    assert.equal((await upload(form({bytes:Buffer.alloc(0)}))).status,400);
    assert.equal((await upload(form({bytes:Buffer.from('not a PNG')}))).status,415);
    assert.equal((await upload(form({type:'image/svg+xml',bytes:Buffer.from('<svg></svg>')}))).status,415);
    assert.equal((await upload(form({folder:'../another-owner'}))).status,400);
    assert.equal((await upload(form({folder:'valid',extra:['owner_id','other-owner']}))).status,400);
    assert.equal((await upload(form({second:true}))).status,400);
    assert.equal((await upload(form({bytes:Buffer.alloc(10*1024*1024+1)}))).status,413);
    assert.equal((await upload('malformed',owner.cookie,{'Content-Type':'multipart/form-data; boundary=not-present'})).status,400);
    assert.equal(calls.length,before);
  });
  await t.test('Provider failures and revoked sessions do not report uploaded files',async()=>{
    failUpload=true;const failed=await upload(form(),user.cookie);assert.equal(failed.status,503);assert.equal(failed.data,null);assert.ok(!JSON.stringify(failed).includes('fake-test-secret'));failUpload=false;
    await pool.query("UPDATE public.owner SET status='blocked' WHERE owner_id=$1",[ownerId]);
    const before=calls.length;assert.equal((await upload(form(),null,{authorization:'Bearer '+owner.data.access_token})).status,401);assert.equal(calls.length,before);
  });
});
