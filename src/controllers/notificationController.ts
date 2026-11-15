import { NotificationRecipient } from '../types/booking';
import { bookingActor,requestPagination } from './bookingController';
import { handler,recordId } from './securityValidation';
import { userBody } from './userValidation';
import * as service from '../services/notificationService';
import { httpError } from '../utils/httpError';
import { success } from '../utils/response';
export function notificationController(type:NotificationRecipient){return {
  list:handler(async(req,res)=>{
    for(const key of Object.keys(req.query))if(!['page','limit','unread_only'].includes(key))httpError(400,'Unsupported notification query');
    const {page,limit}=requestPagination(req.query),unread=req.query.unread_only;
    if(unread!==undefined&&unread!=='true'&&unread!=='false')httpError(400,'unread_only must be true or false');
    success(res,'Notifications',await service.listNotifications(bookingActor(req,res,type),page,limit,unread==='true'));
  }),
  read:handler(async(req,res)=>success(res,'Notification read',await service.markNotificationRead(bookingActor(req,res,type),recordId(req.params.notificationId)))),
  registerDevice:handler(async(req,res)=>{
    const body=userBody(req.body,['token','platform']);
    if(typeof body.token!=='string'||body.token.length<20||body.token.length>4096||/\s/.test(body.token))httpError(400,'Invalid FCM device token');
    if(!['web','android','ios'].includes(body.platform as string))httpError(400,'platform must be web, android or ios');
    success(res,'Push device registered',await service.registerDevice(bookingActor(req,res,type),body.token,body.platform as string));
  }),
  removeDevice:handler(async(req,res)=>success(res,'Push device removed',await service.removeDevice(bookingActor(req,res,type),recordId(req.params.deviceId)))),
};}
