import { setTimeout as pause } from 'node:timers/promises';
import { pool } from '../config/database';
import { bookingTransaction } from '../services/bookingAuthorizationService';
import { expireUnpaidBookings } from '../services/bookingService';
import { reconcilePaymentOrders,processApprovedRefunds } from '../services/bookingPaymentService';
import { processNotificationOutbox } from '../services/notificationDeliveryService';

export async function runBookingWorkerPass():Promise<void>{
  await bookingTransaction(async client=>expireUnpaidBookings(client));
  await reconcilePaymentOrders();
  await processApprovedRefunds();
  await processNotificationOutbox();
}
if(require.main===module){
  let stopped=false;
  process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
  void(async()=>{
    try{
      do{try{await runBookingWorkerPass();}catch{console.error('Booking worker pass failed; retrying.');if(process.argv.includes('--once'))process.exitCode=1;}if(process.argv.includes('--once'))break;if(!stopped)await pause(5000);}while(!stopped);
    }finally{await pool.end();}
  })();
}
