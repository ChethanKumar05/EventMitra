const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {randomBytes,createHmac}=require('node:crypto');
const net=require('node:net');
const url=process.env.BOOKING_TEST_DATABASE_URL;

test('Venue discovery, booking acceptance, Razorpay and notification delivery',{skip:!url&&'Set BOOKING_TEST_DATABASE_URL to a fresh isolated *_test database'},async t=>{
  assert.match(new URL(url).pathname,/_test$/);process.env.DATABASE_URL=url;process.env.NODE_ENV='test';
  process.env.BOOKING_TAX_BPS='1000';process.env.BOOKING_PAYMENT_WINDOW_MINUTES='30';process.env.BOOKING_TIME_ZONE='Asia/Kolkata';process.env.BOOKING_ADMIN_EMAILS='';
  process.env.RAZORPAY_KEY_ID='rzp_test_eventmitra';process.env.RAZORPAY_KEY_SECRET=randomBytes(32).toString('hex');process.env.RAZORPAY_WEBHOOK_SECRET=randomBytes(32).toString('hex');
  for(const key of ['SMTP_HOST','SMTP_FROM','FIREBASE_PROJECT_ID','GOOGLE_APPLICATION_CREDENTIALS'])delete process.env[key];
  const {pool}=require('../dist/config/database'),{runMigrations}=require('../dist/migrations/runMigrations'),{generateId}=require('../dist/utils/id'),{hashPassword,digest}=require('../dist/security/password');
  const originalFetch=global.fetch,orders=new Map(),payments=new Map(),refunds=new Map(),pushes=[],emails=[];
  let orderCalls=0,refundCalls=0,dropOrderResponse=false,pushFailOnce=false,server,smtp;
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  global.fetch=async(input,init={})=>{
    const target=String(input);
    if(target.startsWith('https://fcm.googleapis.com/')){
      const message=JSON.parse(init.body).message;
      if(message.token.includes('invalid-token'))return json({error:{details:[{errorCode:'UNREGISTERED'}]}},400);
      if(pushFailOnce){pushFailOnce=false;return json({error:{status:'UNAVAILABLE'}},503);}
      pushes.push(message);return json({name:'projects/eventmitra-test/messages/'+pushes.length});
    }
    if(!target.startsWith('https://api.razorpay.com/v1/'))return originalFetch(input,init);
    const parsed=new URL(target),path=parsed.pathname.slice(3),method=init.method??'GET';
    assert.match(init.headers.Authorization,/^Basic /);
    if(path==='/orders'&&method==='POST'){
      const body=JSON.parse(init.body),id='order_Test'+(++orderCalls);
      assert.equal(Number.isInteger(body.amount),true);assert.equal(body.currency,'INR');
      const order={id,amount:body.amount,amount_paid:0,currency:body.currency,status:'created',receipt:body.receipt,notes:body.notes};orders.set(id,order);
      if(dropOrderResponse){dropOrderResponse=false;throw new Error('Simulated lost order response');}return json(order);
    }
    if(path==='/orders')return json({items:[...orders.values()].filter(order=>order.receipt===parsed.searchParams.get('receipt'))});
    if(/^\/orders\/[^/]+\/payments$/.test(path))return json({items:[...payments.values()].filter(payment=>payment.order_id===path.split('/')[2])});
    if(/^\/orders\/[^/]+$/.test(path))return json(orders.get(path.split('/')[2]));
    if(/^\/payments\/[^/]+$/.test(path))return json(payments.get(path.split('/')[2]));
    if(/^\/payments\/[^/]+\/refund$/.test(path)){
      const body=JSON.parse(init.body),paymentId=path.split('/')[2],key=init.headers['X-Refund-Idempotency'];
      assert.equal(key,body.receipt);
      if(refunds.has(key))return json(refunds.get(key));
      const refund={id:'rfnd_Test'+(++refundCalls),payment_id:paymentId,amount:body.amount,currency:'INR',status:'processed',receipt:body.receipt};
      refunds.set(key,refund);const payment=payments.get(paymentId);payment.amount_refunded+=body.amount;payment.status='refunded';return json(refund);
    }
    if(/^\/refunds\/[^/]+$/.test(path))return json([...refunds.values()].find(refund=>refund.id===path.split('/')[2]));
    throw new Error('Unexpected mock gateway endpoint '+path);
  };
  const {GoogleAuth}=require('google-auth-library'),originalAccessToken=GoogleAuth.prototype.getAccessToken;
  GoogleAuth.prototype.getAccessToken=async()=> 'local-fcm-test-token';
  t.after(async()=>{
    global.fetch=originalFetch;GoogleAuth.prototype.getAccessToken=originalAccessToken;
    if(server)await new Promise(resolve=>server.close(resolve));if(smtp)await new Promise(resolve=>smtp.close(resolve));await pool.end();
  });
  assert.equal((await pool.query("SELECT to_regclass('public.booking') AS existing")).rows[0].existing,null);
  await runMigrations();
  const password='Booking-test-'+randomBytes(16).toString('hex'),hash=await hashPassword(password),ownerA=generateId(),ownerB=generateId(),blockedOwner=generateId(),userA=generateId(),userB=generateId();
  for(const [id,phone,name,status]of [[ownerA,'9876300001','Booking Owner','verified'],[ownerB,'9876300002','Other Owner','verified'],[blockedOwner,'9876300003','Blocked Owner','blocked']])await pool.query('INSERT INTO public.owner(owner_id,country_code,owner_phone_number,owner_name,user_name,email,password,status) VALUES($1,$2,$3,$4,$3,$5,$6,$7)',[id,'+91',phone,name,phone+'@example.test',hash,status]);
  for(const [id,phone,email]of [[userA,'9876300011','booking-user@example.test'],[userB,'9876300012',null]])await pool.query('INSERT INTO public."user"(user_id,country_code,user_phone_number,user_name,email,gender) VALUES($1,$2,$3,$4,$5,$6)',[id,'+91',phone,'Booking User '+phone,email,'m']);
  await require('../dist/services/adminAuthService').bootstrapSuperAdmin({name:'Booking Admin',email:'booking-admin@example.test',password});
  const venueA=generateId(),venueB=generateId(),unlocated=generateId();
  for(const [id,owner,name,lat,long,city,area,pin,status,active]of [
    [venueA,ownerA,'Near %_ Hall',12.9716,77.5946,'Bengaluru','Central','560001','Active',true],
    [venueB,ownerB,'Far Five Star Hall',13.1,77.8,'Bengaluru','North','560002','Active',true],
    [unlocated,ownerA,'Unrated no coordinates',null,null,'Mysuru','Central','570001','Active',true],
    [generateId(),ownerA,'Unapproved',12.97,77.59,'Bengaluru','Central','560001','Pending',true],
    [generateId(),ownerA,'Inactive',12.97,77.59,'Bengaluru','Central','560001','Active',false],
    [generateId(),blockedOwner,'Blocked supplier',12.97,77.59,'Bengaluru','Central','560001','Active',true],
  ])await pool.query(`INSERT INTO public.venue_details(venue_id,owner_id,venue_name,lat,"long",city,state,area,pin_code,status,is_active,venue_hall_capacity,venue_documents) VALUES($1,$2,$3,$4,$5,$6,'Karnataka',$7,$8,$9,$10,100,ARRAY['private-proof'])`,[id,owner,name,lat,long,city,area,pin,status,active]);
  const date=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10),slotId=generateId(),nightSlot=generateId(),decorationId=generateId(),mealId=generateId(),priceId=generateId(),nightPrice=generateId();
  await pool.query("INSERT INTO public.venue_type_slots(venue_type_slot_id,venue_id,slot_name,from_time,to_time) VALUES($1,$2,'Morning','08:00','16:00'),($3,$2,'Night','18:00','06:00')",[slotId,venueA,nightSlot]);
  await pool.query("INSERT INTO public.venue_decoration_details(venue_decoration_id,venue_id,venue_decoration_name,venue_decoration_price,venue_decoration_advance_price) VALUES($1,$2,'Flowers',1000,200)",[decorationId,venueA]);
  await pool.query('INSERT INTO public.venue_meals_details(venue_meals_id,venue_id,is_veg,per_plate_price,meals_advance_price) VALUES($1,$2,true,100,300)',[mealId,venueA]);
  for(const [id,slot,from,to]of [[priceId,slotId,'08:00','16:00'],[nightPrice,nightSlot,'18:00','06:00']])await pool.query(`INSERT INTO public.venue_price_details(venue_price_id,venue_id,venue_type_slot_id,venue_from_date,venue_to_date,venue_from_time,venue_to_time,venue_price,venue_advance_price,venue_decoration_id,venue_meals_id) VALUES($1,$2,$3,$4,$5,$6,$7,10000,2000,$8,$9)`,[id,venueA,slot,date(1),date(365),from,to,decorationId,mealId]);
  let ratingFixture=0;
  for(const [venue,rating]of [[venueA,1],[venueA,3],[venueB,5]]){
    const id=generateId(),day='2020-01-'+String(++ratingFixture).padStart(2,'0');
    await pool.query("INSERT INTO public.booking(booking_id,user_id,venue_id,booking_from,booking_to,booking_status) VALUES($1,$2,$3,$4,$5,'Accepted')",[id,userA,venue,day+'T08:00:00Z',day+'T16:00:00Z']);
    await pool.query('INSERT INTO public.venue_meal_decoration_ratings(rating_id,venue_id,user_id,booking_id,venue_rating) VALUES($1,$2,$3,$4,$5)',[generateId(),venue,userA,id,rating]);
  }
  const {app}=require('../dist/app');server=app.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  async function request(path,method='GET',body,cookie,extra={}){
    const response=await fetch(origin+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{cookie}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
    return {...await response.json(),status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function userLogin(phone){const challenge=await request('/api/user/auth/login','POST',{country_code:'+91',user_phone_number:phone});return request('/api/user/auth/verify-otp','POST',{otp:'1111',otp_token:challenge.data.otp_token});}
  const userCookie=(await userLogin('9876300011')).cookie,otherCookie=(await userLogin('9876300012')).cookie,
    ownerCookie=(await request('/api/owner/auth/login','POST',{email:'9876300001@example.test',password})).cookie,otherOwnerCookie=(await request('/api/owner/auth/login','POST',{email:'9876300002@example.test',password})).cookie,
    adminCookie=(await request('/api/admin/auth/login','POST',{email:'booking-admin@example.test',password})).cookie;
  const user=(path,method='GET',body,cookie=userCookie,headers={})=>request('/api/user'+path,method,body,cookie,headers);
  const owner=(path,method='GET',body,cookie=ownerCookie)=>request('/api/owner'+path,method,body,cookie);
  const admin=(path,method='GET',body,cookie=adminCookie)=>request('/api/admin'+path,method,body,cookie);
  const body=(offset=30,patch={})=>({venue_price_id:priceId,booking_date:date(offset),guest_count:10,include_decoration:true,include_meals:true,...patch});
  const create=(input,key=randomBytes(16).toString('hex'),cookie=userCookie)=>user('/bookings','POST',input,cookie,{'Idempotency-Key':key});
  const accept=id=>owner('/bookings/'+id+'/decision','POST',{decision:'accept'});
  const signature=(order,payment)=>createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(order+'|'+payment).digest('hex');
  const verify=(id,order,payment,patch={},cookie=userCookie)=>user('/bookings/'+id+'/verify-payment','POST',{razorpay_order_id:order,razorpay_payment_id:payment,razorpay_signature:signature(order,payment),...patch},cookie);
  function pay(orderId,status='captured'){
    const order=orders.get(orderId),id='pay_Test'+(payments.size+1),payment={id,order_id:orderId,amount:order.amount,currency:'INR',status,captured:status==='captured',amount_refunded:0};payments.set(id,payment);
    order.status=status==='captured'?'paid':'attempted';order.amount_paid=status==='captured'?order.amount:0;return payment;
  }
  async function webhook(payload,eventId='event_'+randomBytes(8).toString('hex'),rawSuffix='',badSignature=false){
    const raw=JSON.stringify(payload),sig=createHmac('sha256',process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    const response=await fetch(origin+'/api/payments/razorpay/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-razorpay-signature':badSignature?'a'.repeat(64):sig,'x-razorpay-event-id':eventId},body:raw+rawSuffix});return {...await response.json(),status:response.status};
  }
  let mainBooking,mainOrder,mainPayment,refundId;

  await t.test('User venue discovery sorts by rating or distance and applies location filters',async()=>{
    assert.equal((await request('/api/user/venues')).status,401);
    const ranked=await user('/venues');assert.equal(ranked.status,200,ranked.message);assert.equal(ranked.data.total,3);
    assert.deepEqual(ranked.data.items.map(row=>row.venue_id),[venueB,venueA,unlocated]);assert.equal(ranked.data.items[0].rating,5);assert.equal(ranked.data.items[1].rating,2);assert.equal(ranked.data.items[1].rating_count,2);assert.equal(ranked.data.items[2].rating,0);
    const near=await user('/venues?lat=12.9716&long=77.5946&distance_km=2');assert.equal(near.status,200);assert.equal(near.data.total,1);assert.equal(near.data.items[0].venue_id,venueA);assert.ok(near.data.items[0].distance_km<0.001);
    const distance=await user('/venues?sort_by=distance&lat=12.9716&long=77.5946');assert.deepEqual(distance.data.items.map(row=>row.venue_id),[venueA,venueB,unlocated]);assert.equal(distance.data.items[2].distance_km,null);
    assert.equal((await user('/venues?sort_by=rating&lat=12.9716&long=77.5946')).data.items[0].venue_id,venueB);
    assert.equal((await user('/venues?city=bengaluru&state=karnataka&area=central&pin_code=560001')).data.total,1);
    assert.equal((await user('/venues?min_rating=4')).data.total,1);
    assert.equal((await user('/venues?search=%25_')).data.items[0].venue_id,venueA);
    const page=await user('/venues?limit=1&page=2');assert.equal(page.data.total,3);assert.equal(page.data.hasNextPage,true);assert.equal(page.data.hasPreviousPage,true);
    assert.deepEqual((await user('/venues?page=99')).data.items,[]);
    for(const query of ['lat=91&long=0','lat=0','long=0','lat=x&long=0','distance_km=1','sort_by=distance','sort_by=name','page=0','limit=101','lat=1&lat=2&long=0','min_rating=6','unknown=x'])assert.equal((await user('/venues?'+query)).status,400,query);
    const detail=await user('/venues/'+venueA);assert.equal(detail.status,200);assert.equal(detail.data.venue_type_slots.length,2);assert.equal(detail.data.venue_price_details.length,2);assert.equal(detail.data.venue_documents,undefined);assert.equal(detail.data.owner_id,undefined);
  });

  await t.test('Server-priced quote, booking creation, idempotency and scoped notifications',async()=>{
    const quote=await user('/bookings/quote','POST',body());assert.equal(quote.status,200,quote.message);assert.equal(quote.data.total_amount,'13200.00');assert.equal(quote.data.advance_amount,'2750.00');assert.equal(quote.data.balance_amount,'10450.00');
    for(const patch of [{guest_count:0},{guest_count:101},{booking_date:'2027-02-30'},{booking_date:'2020-01-01'},{include_meals:'true'},{total_amount:1},{user_id:userB}])assert.ok([400,409].includes((await create(body(30,patch))).status));
    assert.equal((await user('/bookings','POST',body())).status,400,'Idempotency key required');
    assert.equal((await create(body(32),undefined,otherCookie)).status,400,'Missing profile email requires contact_email');
    const key=randomBytes(16).toString('hex'),created=await create(body(),key);assert.equal(created.status,201,created.message);mainBooking=created.data.booking_id;
    assert.match(created.data.booking_code,/^BKG[0-9]{5,}$/);assert.equal(created.data.booking_status,'Requested');assert.equal(created.data.payment_state,'awaiting_acceptance');assert.equal(created.data.is_confirmed,false);assert.equal(created.data.booking_payment_details[0].payment_amount,2750);assert.equal(created.data.booking_price_details.total_amount,13200);
    const repeat=await create(body(),key);assert.equal(repeat.status,200);assert.equal(repeat.data.booking_id,mainBooking);
    assert.equal((await create(body(30,{guest_count:11}),key)).status,409);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.notifications WHERE event_key=$1',['requested:'+mainBooking])).rows[0].n,3);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.notification_outbox WHERE event_key=$1',['requested:'+mainBooking])).rows[0].n,6);
    assert.equal((await user('/bookings/'+mainBooking,'GET',undefined,otherCookie)).status,404);assert.equal((await owner('/bookings/'+mainBooking,'GET',undefined,otherOwnerCookie)).status,404);
    const mine=await user('/notifications?unread_only=true');const notification=mine.data.items.find(row=>row.data.booking_id===mainBooking);assert.ok(notification);
    assert.equal((await user('/notifications/'+notification.notification_id+'/read','PUT',undefined,otherCookie)).status,404);
    assert.equal((await user('/notifications/'+notification.notification_id+'/read','PUT')).status,200);
    assert.ok((await owner('/notifications')).data.items.some(row=>row.data.booking_id===mainBooking));assert.ok((await admin('/notifications')).data.items.some(row=>row.data.booking_id===mainBooking));
    const token='token-test-'+randomBytes(20).toString('hex');const device=await user('/notifications/devices','POST',{token,platform:'web'});assert.equal(device.status,200);assert.equal(device.data.token,undefined);
    assert.equal((await user('/notifications/devices/'+device.data.device_id,'DELETE',undefined,otherCookie)).status,404);
    assert.equal((await user('/notifications/devices','POST',{token,platform:'web',recipient_id:userB})).status,400);
    await owner('/notifications/devices','POST',{token:'owner-token-'+randomBytes(20).toString('hex'),platform:'android'});
    await admin('/notifications/devices','POST',{token:'admin-token-'+randomBytes(20).toString('hex'),platform:'web'});
    const night=await user('/bookings/quote','POST',body(33,{venue_price_id:nightPrice}));assert.equal(night.status,200);assert.equal(new Date(night.data.booking_to)-new Date(night.data.booking_from),12*3600000);
  });

  await t.test('Owner acceptance precedes advance checkout; server verification requires captured payment',async()=>{
    assert.equal((await user('/bookings/'+mainBooking+'/payment-order','POST')).status,409);assert.equal(orderCalls,0);
    assert.equal((await owner('/bookings/'+mainBooking+'/decision','POST',{decision:'accept'},otherOwnerCookie)).status,404);
    assert.equal((await owner('/bookings/'+mainBooking+'/decision','POST',{decision:'reject'})).status,400);
    const competing=await create(body(30,{contact_email:'other-user@example.test'}),undefined,otherCookie);assert.equal(competing.status,201);
    const accepted=await accept(mainBooking);assert.equal(accepted.status,200,accepted.message);assert.equal(accepted.data.payment_state,'awaiting_payment');assert.ok(accepted.data.payment_expires_at);assert.equal(accepted.data.is_confirmed,false);
    assert.equal((await accept(competing.data.booking_id)).status,409);assert.equal((await create(body())).status,409);
    assert.equal((await accept(mainBooking)).status,200,'Acceptance retry is idempotent');
    await pool.query('UPDATE public.venue_price_details SET venue_price=99000,venue_advance_price=9000 WHERE venue_price_id=$1',[priceId]);
    const checkout=await user('/bookings/'+mainBooking+'/payment-order','POST');assert.equal(checkout.status,200,checkout.message);mainOrder=checkout.data.order_id;assert.equal(checkout.data.amount,275000);assert.equal(checkout.data.key_id,'rzp_test_eventmitra');assert.ok(!JSON.stringify(checkout).includes(process.env.RAZORPAY_KEY_SECRET));
    assert.equal((await user('/bookings/'+mainBooking+'/payment-order','POST')).data.order_id,mainOrder);assert.equal(orderCalls,1);
    await pool.query('UPDATE public.venue_price_details SET venue_price=10000,venue_advance_price=2000 WHERE venue_price_id=$1',[priceId]);
    mainPayment=pay(mainOrder,'authorized');
    assert.equal((await verify(mainBooking,mainOrder,mainPayment.id,{razorpay_signature:'a'.repeat(64)})).status,401);
    assert.equal((await verify(mainBooking,mainOrder,mainPayment.id,{},otherCookie)).status,404);
    assert.equal((await verify(mainBooking,mainOrder,mainPayment.id,{payment_amount:1})).status,400);
    const authorized=await verify(mainBooking,mainOrder,mainPayment.id);assert.equal(authorized.status,202);assert.equal(authorized.data.is_confirmed,false);
    const expectedAmount=mainPayment.amount;
    mainPayment.amount=expectedAmount+100;assert.equal((await verify(mainBooking,mainOrder,mainPayment.id)).status,409);mainPayment.amount=expectedAmount;
    mainPayment.currency='USD';assert.equal((await verify(mainBooking,mainOrder,mainPayment.id)).status,409);mainPayment.currency='INR';
    mainPayment.status='captured';mainPayment.captured=true;orders.get(mainOrder).status='paid';orders.get(mainOrder).amount_paid=mainPayment.amount;
    const paid=await verify(mainBooking,mainOrder,mainPayment.id);assert.equal(paid.status,200,paid.message);assert.equal(paid.data.payment_state,'paid');assert.equal(paid.data.is_advance_paid,true);assert.equal(paid.data.is_confirmed,true);
    assert.equal(paid.data.booking_price_details.total_amount,13200,'Price snapshot survives config edits');
    assert.equal((await verify(mainBooking,mainOrder,mainPayment.id)).status,200);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.notifications WHERE event_key=$1',['advance_paid:'+mainBooking])).rows[0].n,3);
  });

  await t.test('Raw signed webhooks are idempotent and failures cannot undo captured money',async()=>{
    const event={event:'payment.captured',payload:{payment:{entity:{id:mainPayment.id}}}};
    assert.equal((await webhook(event,'invalid_signature','',true)).status,401);
    assert.equal((await webhook(event,'modified_body',' ')).status,401,'Signature uses exact raw bytes');
    assert.equal((await webhook(event,'capture_event')).status,200);
    const duplicate=await webhook(event,'capture_event');assert.equal(duplicate.status,200);assert.equal(duplicate.data.duplicate,true);
    assert.equal((await webhook({event:'payment.failed'},'capture_event')).status,409);
    assert.equal((await webhook({event:'payment.failed'},'late_failure')).status,200);
    assert.equal((await user('/bookings/'+mainBooking)).data.payment_state,'paid');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.notifications WHERE event_key=$1',['advance_paid:'+mainBooking])).rows[0].n,3);
  });

  await t.test('Paid owner rejection requires admin refund review, not an automatic refund',async()=>{
    const rejected=await owner('/bookings/'+mainBooking+'/decision','POST',{decision:'reject',reason:'Supplier unavailable'});assert.equal(rejected.status,200);assert.equal(rejected.data.booking_status,'Rejected');assert.equal(rejected.data.payment_state,'refund_review');assert.equal(rejected.data.is_confirmed,false);
    refundId=rejected.data.refund_reviews[0].refund_review_id;assert.equal(rejected.data.refund_reviews[0].status,'Pending');assert.equal(refundCalls,0);
    await require('../dist/services/bookingPaymentService').processApprovedRefunds();assert.equal(refundCalls,0);
    assert.equal((await owner('/bookings/'+mainBooking+'/decision','POST',{decision:'reject',reason:'Retry'})).data.refund_reviews.length,1);
    const role=(await admin('/roles','POST',{role_type:'Booking reviewer'})).data.role_id;
    const delegatedId=(await admin('/admins','POST',{admin_name:'Reviewer',admin_username:'booking_reviewer',admin_email:'reviewer@example.test',password,role_id:role})).data.admin_id;
    const delegated=(await request('/api/admin/auth/login','POST',{email:'reviewer@example.test',password})).cookie;
    assert.equal((await admin('/bookings','GET',undefined,delegated)).status,403);
    const moduleId=(await admin('/modules','POST',{module_name:'Booking Management',module_key:'booking_management'})).data.module_id;
    await admin('/admin-permissions','POST',{admin_id:delegatedId,role_id:role,module_id:moduleId,read:true});
    assert.equal((await admin('/bookings','GET',undefined,delegated)).status,200);
    assert.equal((await admin('/bookings/refund-reviews?status=Pending','GET',undefined,delegated)).data.total,1);
    const path='/bookings/'+mainBooking+'/refund-reviews/'+refundId+'/decision';
    assert.equal((await admin(path,'POST',{decision:'approve',reason:'Approved review'},delegated)).status,403);
    await admin('/admin-permissions','POST',{admin_id:delegatedId,role_id:role,module_id:moduleId,edit:true});
    const approved=await admin(path,'POST',{decision:'approve',reason:'Owner cannot provide venue'},delegated);assert.equal(approved.status,200);assert.equal(approved.data.refund_reviews[0].status,'Approved');assert.equal(refundCalls,0);
    await require('../dist/services/bookingPaymentService').processApprovedRefunds();assert.equal(refundCalls,1);
    const refunded=(await user('/bookings/'+mainBooking)).data;assert.equal(refunded.payment_state,'refunded');assert.equal(refunded.is_advance_paid,false);assert.equal(refunded.refund_reviews[0].status,'Processed');
    await require('../dist/services/bookingPaymentService').processApprovedRefunds();assert.equal(refundCalls,1,'Approved refund is sent once with a stable provider idempotency key');
    assert.equal((await admin(path,'POST',{decision:'approve',reason:'Retry'},delegated)).status,409);
  });

  await t.test('Reservation races, expiry, uncertain order recovery and missed callbacks',async()=>{
    await pool.query('DELETE FROM public.booking_request_limits');
    const first=await create(body(40)),second=await create(body(40));assert.equal(first.status,201);assert.equal(second.status,201);
    const decisions=await Promise.all([accept(first.data.booking_id),accept(second.data.booking_id)]);assert.deepEqual(decisions.map(row=>row.status).sort(),[200,409]);
    const selected=decisions.find(row=>row.status===200).data.booking_id;
    await pool.query("UPDATE public.booking SET payment_expires_at=now()-interval '1 second' WHERE booking_id=$1",[selected]);
    await require('../dist/services/bookingAuthorizationService').bookingTransaction(client=>require('../dist/services/bookingService').expireUnpaidBookings(client));
    assert.equal((await user('/bookings/'+selected)).data.payment_state,'expired');assert.equal((await user('/bookings/'+selected+'/payment-order','POST')).status,409);
    const waiting=first.data.booking_id===selected?second.data.booking_id:first.data.booking_id;assert.equal((await accept(waiting)).status,200,'Expiry releases the venue reservation');
    const uncertain=(await create(body(41))).data.booking_id;await accept(uncertain);dropOrderResponse=true;const before=orderCalls;
    assert.equal((await user('/bookings/'+uncertain+'/payment-order','POST')).status,503);assert.equal(orderCalls,before+1);
    assert.equal((await user('/bookings/'+uncertain+'/payment-order','POST')).status,202);assert.equal(orderCalls,before+1,'Uncertain gateway POST is never blindly repeated');
    await require('../dist/services/bookingPaymentService').reconcilePaymentOrders();
    const recovered=await user('/bookings/'+uncertain+'/payment-order','POST');assert.equal(recovered.status,200);assert.equal(orderCalls,before+1);
    pay(recovered.data.order_id);await pool.query('UPDATE public.booking_payment_details SET last_reconciled_at=NULL WHERE booking_id=$1',[uncertain]);
    await require('../dist/services/bookingPaymentService').reconcilePaymentOrders();assert.equal((await user('/bookings/'+uncertain)).data.payment_state,'paid','Worker polling recovers a captured payment without frontend callback/webhook');
    const late=(await create(body(42))).data.booking_id;await accept(late);const order=(await user('/bookings/'+late+'/payment-order','POST')).data.order_id;
    await pool.query("UPDATE public.booking SET payment_expires_at=now()-interval '1 second' WHERE booking_id=$1",[late]);
    await require('../dist/services/bookingAuthorizationService').bookingTransaction(client=>require('../dist/services/bookingService').expireUnpaidBookings(client));
    const latePayment=pay(order);assert.equal((await webhook({event:'payment.captured',payload:{payment:{entity:{id:latePayment.id}}}})).status,200);
    const lateBooking=(await user('/bookings/'+late)).data;assert.equal(lateBooking.booking_status,'Cancelled');assert.equal(lateBooking.payment_state,'refund_review');assert.equal(lateBooking.is_confirmed,false);assert.equal(refundCalls,1,'Late capture waits for admin refund review');
    await pool.query('UPDATE public.venue_price_details SET venue_advance_price=0 WHERE venue_price_id=$1',[priceId]);
    const zero=(await create(body(43,{include_decoration:false,include_meals:false}))).data.booking_id;const freeAdvance=await accept(zero);assert.equal(freeAdvance.data.payment_state,'not_required');assert.equal(freeAdvance.data.is_confirmed,true);assert.equal((await user('/bookings/'+zero+'/payment-order','POST')).status,409);
    await pool.query('UPDATE public.venue_price_details SET venue_advance_price=2000 WHERE venue_price_id=$1',[priceId]);
    const external=(await create(body(44))).data.booking_id;await accept(external);const externalOrder=(await user('/bookings/'+external+'/payment-order','POST')).data.order_id;
    const externalPayment=pay(externalOrder);await verify(external,externalOrder,externalPayment.id);
    externalPayment.amount_refunded=externalPayment.amount;externalPayment.status='refunded';
    const externalRefund={id:'rfnd_ExternalFull',payment_id:externalPayment.id,amount:externalPayment.amount,currency:'INR',status:'processed',receipt:'manual-dashboard'};refunds.set('external',externalRefund);
    assert.equal((await webhook({event:'refund.processed',payload:{refund:{entity:{id:externalRefund.id}}}})).status,200);
    const reconciled=(await user('/bookings/'+external)).data;assert.equal(reconciled.payment_state,'refunded');assert.equal(reconciled.is_confirmed,false);assert.equal(reconciled.is_advance_paid,false,'Provider-reported refunds cannot leave a booking paid/confirmed');
    const partial=(await create(body(45))).data.booking_id;await accept(partial);
    const partialOrder=(await user('/bookings/'+partial+'/payment-order','POST')).data.order_id;
    const partialPayment=pay(partialOrder);partialPayment.amount_refunded=50000;
    assert.equal((await webhook({event:'payment.captured',payload:{payment:{entity:{id:partialPayment.id}}}})).status,200);
    const partialBooking=(await user('/bookings/'+partial)).data;
    assert.equal(partialBooking.is_confirmed,false);assert.equal(partialBooking.payment_state,'refund_review');
    assert.equal(partialBooking.refund_reviews[0].amount,2250,'A capture discovered after a partial refund reviews only the remaining advance');
    const imminent=(await create(body(46))).data.booking_id;
    await pool.query("UPDATE public.booking SET booking_from=now()+interval '5 minutes',booking_to=now()+interval '6 hours' WHERE booking_id=$1",[imminent]);
    const imminentAccepted=(await accept(imminent)).data;
    assert.equal(imminentAccepted.payment_expires_at,imminentAccepted.booking_from,'Advance payment cannot remain open beyond the booking start time');
  });

  await t.test('Date-specific prices take precedence; slot defaults fill gaps in search, quote and creation',async()=>{
    const venue=(await admin('/venues','POST',{owner_id:ownerA,venue_name:'Default Pricing Hall',city:'Bengaluru',lat:0,long:0,status:'Active',is_active:true,venue_hall_capacity:100})).data.venue_id;
    const daySlot=(await admin(`/venues/${venue}/type-slots`,'POST',{slot_name:'Day',from_time:'08:00',to_time:'16:00'})).data.venue_type_slot_id;
    const lateSlot=(await admin(`/venues/${venue}/type-slots`,'POST',{slot_name:'Night',from_time:'18:00',to_time:'06:00'})).data.venue_type_slot_id;
    const basePrice={venue_type_slot_id:daySlot,venue_from_date:date(1),venue_to_date:date(2),venue_from_time:'08:00',venue_to_time:'16:00',venue_price:1000,venue_advance_price:100};
    const fallback=await admin(`/venues/${venue}/prices`,'POST',{...basePrice,is_default:true});assert.equal(fallback.status,201,fallback.message);
    const dated=await admin(`/venues/${venue}/prices`,'POST',{...basePrice,venue_from_date:date(60),venue_to_date:date(65),venue_price:2000,venue_advance_price:200});assert.equal(dated.status,201);assert.equal(dated.data.is_default,false);
    const nightFallback=await admin(`/venues/${venue}/prices`,'POST',{...basePrice,venue_type_slot_id:lateSlot,venue_from_time:'18:00',venue_to_time:'06:00',is_default:true});assert.equal(nightFallback.status,201);
    const fallbackId=fallback.data.venue_price_id,datedId=dated.data.venue_price_id,nightId=nightFallback.data.venue_price_id;
    const read=offset=>user(`/venues/${venue}?booking_date=${date(offset)}`);
    const dayPrice=response=>response.data.venue_price_details.find(row=>row.venue_type_slot_id===daySlot);
    for(const offset of [60,65]){const result=await read(offset);assert.equal(result.status,200);assert.equal(dayPrice(result).venue_price_id,datedId);assert.equal(dayPrice(result).price_source,'date_specific');assert.ok(result.data.venue_price_details.some(row=>row.venue_price_id===nightId));assert.ok(!result.data.venue_price_details.some(row=>row.venue_price_id===fallbackId),'Default is suppressed when a dated price covers the slot');}
    for(const offset of [59,66,70]){const result=await read(offset);assert.equal(result.data.has_price_for_date,true);assert.equal(result.data.booking_date,date(offset));assert.equal(dayPrice(result).venue_price_id,fallbackId);assert.equal(dayPrice(result).is_default,true);assert.equal(dayPrice(result).price_source,'default');}
    const search=await user('/venues?search=Default%20Pricing%20Hall&page=1&limit=1&city=bengaluru&lat=0&long=0&distance_km=1&booking_date='+date(70));assert.equal(search.status,200);assert.equal(search.data.total,1);assert.equal(search.data.items[0].venue_id,venue);
    assert.deepEqual(search.data.items[0].venue_price_details,(await read(70)).data.venue_price_details,'Discovery and detail resolve the same default rows');
    assert.equal((await user('/venues?search=Default%20Pricing%20Hall&page=2&limit=1&booking_date='+date(70))).data.items.length,0);
    assert.equal((await user('/venues/'+venue)).data.venue_price_details.length,3,'Undated detail keeps all price configurations');
    for(const query of ['booking_date=2027-02-30','booking_date=0000-01-01','booking_date=bad','booking_date='+date(70)+'&booking_date='+date(71)]){
      assert.equal((await user('/venues?'+query)).status,400);assert.equal((await user('/venues/'+venue+'?'+query)).status,400);
    }
    const input={venue_price_id:fallbackId,booking_date:date(70),guest_count:10,include_decoration:false,include_meals:false};
    const quote=await user('/bookings/quote','POST',input);assert.equal(quote.status,200,quote.message);assert.equal(quote.data.venue_price_id,fallbackId);assert.equal(quote.data.venue_amount,'1000.00');assert.equal(quote.data.advance_amount,'110.00');assert.equal(quote.data.price_source,'default');assert.equal(quote.data.is_default,true);
    const staleInput={...input,venue_price_id:datedId};const resolved=await user('/bookings/quote','POST',staleInput);assert.equal(resolved.status,200);assert.equal(resolved.data.venue_price_id,fallbackId);assert.equal(resolved.data.requested_venue_price_id,datedId);
    assert.equal((await user('/bookings/quote','POST',{...input,booking_date:date(60)})).status,409,'A client cannot force a cheaper default over date-specific prices');
    const exact=await user('/bookings/quote','POST',{...input,venue_price_id:datedId,booking_date:date(60)});assert.equal(exact.status,200);assert.equal(exact.data.venue_amount,'2000.00');assert.equal(exact.data.price_source,'date_specific');
    await pool.query('DELETE FROM public.booking_request_limits');
    const key=randomBytes(16).toString('hex'),created=await create(staleInput,key);assert.equal(created.status,201,created.message);assert.equal(created.data.venue_price_id,fallbackId);assert.equal(created.data.price_snapshot.price.is_default,true);assert.equal(created.data.price_snapshot.price_source,'default');assert.equal(created.data.booking_payment_details[0].payment_amount,110);
    assert.equal((await create(staleInput,key)).data.booking_id,created.data.booking_id);
    await admin(`/venues/${venue}/prices`,'POST',{venue_price_id:fallbackId,venue_price:1500});
    assert.equal((await user('/bookings/'+created.data.booking_id)).data.booking_price_details.venue_amount,1000,'Later default changes never reprice existing bookings');
    await admin(`/venues/${venue}/type-slots`,'POST',{venue_type_slot_id:daySlot,is_active:false});assert.equal((await read(70)).data.venue_price_details.some(row=>row.venue_price_id===fallbackId),false);assert.equal((await user('/bookings/quote','POST',input)).status,409,'Default prices cannot bypass an inactive slot');
    await admin(`/venues/${venue}/type-slots`,'POST',{venue_type_slot_id:daySlot,is_active:true});
    for(const id of [fallbackId,nightId])assert.equal((await admin(`/venues/${venue}/prices`,'POST',{venue_price_id:id,is_default:false})).status,200);
    const unavailable=await read(70);assert.deepEqual(unavailable.data.venue_price_details,[]);assert.equal(unavailable.data.has_price_for_date,false);assert.equal((await user('/bookings/quote','POST',staleInput)).status,409);
    const noPriceSearch=await user('/venues?search=Default%20Pricing%20Hall&booking_date='+date(70));assert.equal(noPriceSearch.data.total,1);assert.equal(noPriceSearch.data.items[0].has_price_for_date,false,'Venues without pricing remain identifiable and are never given a fabricated zero price');
  });

  await t.test('SMTP and Firebase delivery use a durable outbox, scoped tokens and retries',async()=>{
    const delivery=require('../dist/services/notificationDeliveryService');
    await delivery.processNotificationOutbox();
    assert.ok((await pool.query("SELECT 1 FROM public.notification_outbox WHERE status='pending' AND attempts=0 AND last_error='Delivery provider is not configured'")).rowCount);
    smtp=net.createServer(socket=>{
      let buffer='',dataMode=false,recipients=[];socket.write('220 local-test SMTP\r\n');
      socket.on('data',chunk=>{buffer+=chunk.toString();while(true){
        if(dataMode){const end=buffer.indexOf('\r\n.\r\n');if(end<0)break;emails.push({recipients:[...recipients],body:buffer.slice(0,end)});buffer=buffer.slice(end+5);dataMode=false;socket.write('250 queued\r\n');continue;}
        const end=buffer.indexOf('\r\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(/^(EHLO|HELO)/i.test(line))socket.write('250-local-test\r\n250 PIPELINING\r\n');
        else if(/^MAIL FROM/i.test(line)){recipients=[];socket.write('250 sender ok\r\n');}
        else if(/^RCPT TO/i.test(line)){recipients.push(line.match(/<([^>]+)>/)?.[1]);socket.write('250 recipient ok\r\n');}
        else if(/^DATA$/i.test(line)){dataMode=true;socket.write('354 send message\r\n');}
        else if(/^QUIT$/i.test(line)){socket.end('221 bye\r\n');break;}else socket.write('250 ok\r\n');
      }});
    });smtp.listen(0,'127.0.0.1');await once(smtp,'listening');
    process.env.SMTP_HOST='127.0.0.1';process.env.SMTP_PORT=String(smtp.address().port);process.env.SMTP_SECURE='false';process.env.SMTP_REQUIRE_TLS='false';process.env.SMTP_FROM='notifications@example.test';delete process.env.SMTP_USER;
    process.env.FIREBASE_PROJECT_ID='eventmitra-test';
    const invalidToken='invalid-token-'+randomBytes(20).toString('hex');await user('/notifications/devices','POST',{token:invalidToken,platform:'web'});
    pushFailOnce=true;await pool.query("UPDATE public.notification_outbox SET next_attempt_at=now() WHERE status='pending'");
    for(let i=0;i<100;i++)if(!await delivery.processNotificationOutbox())break;
    assert.ok(emails.length>0);assert.ok(emails.some(mail=>mail.recipients.includes('booking-user@example.test')));assert.ok(emails.some(mail=>mail.recipients.includes('9876300001@example.test')));assert.ok(emails.some(mail=>mail.recipients.includes('booking-admin@example.test')));
    assert.ok(pushes.length>0);assert.ok(pushes.every(message=>typeof message.data.notification_id==='string'));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.notification_devices WHERE token_hash=$1',[digest(invalidToken)])).rows[0].n,0,'Invalid FCM registrations are removed');
    assert.ok((await pool.query('SELECT 1 FROM public.notification_outbox WHERE attempts>0')).rowCount,'Transient FCM failures schedule retries');
    await pool.query("UPDATE public.notification_outbox SET next_attempt_at=now() WHERE status='pending'");for(let i=0;i<20;i++)if(!await delivery.processNotificationOutbox())break;
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.notification_outbox WHERE status IN ('pending','processing','failed')")).rows[0].n,0);
  });
  await runMigrations();
});
