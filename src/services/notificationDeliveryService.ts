import nodemailer from 'nodemailer';
import { GoogleAuth } from 'google-auth-library';
import { pool } from '../config/database';
import { digest } from '../security/password';
import { httpError } from '../utils/httpError';

export interface NotificationPayload {notification_id:string;title:string;body:string;data:Record<string,string>;}
export async function sendNotificationEmail(destination:string,payload:NotificationPayload):Promise<void>{
  if(!process.env.SMTP_HOST||!process.env.SMTP_FROM)httpError(503,'SMTP is not configured');
  const port=Number(process.env.SMTP_PORT??465);
  if(!Number.isInteger(port)||port<1||port>65535)httpError(503,'Invalid SMTP port configuration');
  const transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port,secure:process.env.SMTP_SECURE==='true'||port===465,
    requireTLS:process.env.SMTP_REQUIRE_TLS!=='false',auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}:undefined,
    connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000});
  try{await transport.sendMail({from:process.env.SMTP_FROM,to:destination,subject:payload.title,text:`${payload.body}\n\nBooking: ${payload.data.booking_code??''}\nReference: ${payload.data.booking_id??''}`});}
  finally{transport.close();}
}

export async function sendNotificationPush(recipientType:string,recipientId:string,payload:NotificationPayload):Promise<boolean>{
  const devices=(await pool.query('SELECT token FROM public.notification_devices WHERE recipient_type=$1 AND recipient_id=$2',[recipientType,recipientId])).rows;
  if(!devices.length)return false;
  if(!process.env.FIREBASE_PROJECT_ID&&!process.env.GOOGLE_APPLICATION_CREDENTIALS)httpError(503,'Firebase is not configured');
  const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/firebase.messaging'],...(process.env.FIREBASE_PROJECT_ID?{projectId:process.env.FIREBASE_PROJECT_ID}:{})});
  const project=process.env.FIREBASE_PROJECT_ID??await auth.getProjectId(),accessToken=await auth.getAccessToken();
  if(!accessToken)httpError(503,'Firebase access token is unavailable');
  let transientFailure=false,successes=0;
  for(let offset=0;offset<devices.length;offset+=10){
    await Promise.all(devices.slice(offset,offset+10).map(async device=>{
      try{
        const response=await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`,{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({message:{token:device.token,notification:{title:payload.title,body:payload.body.slice(0,500)},data:{...payload.data,notification_id:payload.notification_id}}}),signal:AbortSignal.timeout(15000)});
        if(response.ok){successes++;return;}
        const error=await response.json() as {error?:{details?:Array<{errorCode?:string}>}};
        if(error.error?.details?.some(detail=>['UNREGISTERED','INVALID_ARGUMENT'].includes(detail.errorCode??'')))await pool.query('DELETE FROM public.notification_devices WHERE token_hash=$1 AND recipient_type=$2 AND recipient_id=$3',[digest(device.token),recipientType,recipientId]);
        else transientFailure=true;
      }catch{transientFailure=true;}
    }));
  }
  if(transientFailure)throw new Error('Push delivery needs retry');return successes>0;
}

export async function processNotificationOutbox():Promise<number>{
  const deliveries=(await pool.query(`UPDATE public.notification_outbox SET status='processing',locked_at=now() WHERE delivery_id IN(
    SELECT delivery_id FROM public.notification_outbox WHERE (status='pending' AND next_attempt_at<=now()) OR (status='processing' AND locked_at<now()-interval '5 minutes')
    ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows;
  for(const delivery of deliveries){
    try{
      let sent=true;
      if(delivery.channel==='email'){
        if(!delivery.destination)sent=false;else await sendNotificationEmail(delivery.destination,delivery.payload);
      }else sent=await sendNotificationPush(delivery.recipient_type,delivery.recipient_id,delivery.payload);
      await pool.query(`UPDATE public.notification_outbox SET status=$2,delivered_at=now(),locked_at=NULL,last_error=$3 WHERE delivery_id=$1`,[delivery.delivery_id,sent?'sent':'skipped',sent?null:'No email address or registered push device']);
    }catch(error){
      const notConfigured=(error as {status?:number}).status===503,attempts=delivery.attempts+(notConfigured?0:1),delay=notConfigured?300:Math.min(3600,15*2**Math.min(attempts,8));
      await pool.query(`UPDATE public.notification_outbox SET status=$2,attempts=$3,locked_at=NULL,next_attempt_at=now()+($4::int*interval '1 second'),last_error=$5 WHERE delivery_id=$1`,[delivery.delivery_id,attempts>=8?'failed':'pending',attempts,delay,notConfigured?'Delivery provider is not configured':'Delivery failed; retry scheduled']);
    }
  }
  return deliveries.length;
}
