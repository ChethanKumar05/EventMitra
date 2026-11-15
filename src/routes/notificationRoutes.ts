import { Router } from 'express';
import { notificationController } from '../controllers/notificationController';
import { authenticateUser } from '../middleware/userAuth';
import { authenticateOwner } from '../middleware/ownerAuth';
import { authenticateAdmin,securityHeaders } from '../middleware/adminAuth';
import { NotificationRecipient } from '../types/booking';

export function notificationRoutes(type:NotificationRecipient){
  const router=Router(),controller=notificationController(type);
  if(type==='admin')router.use(securityHeaders,authenticateAdmin);else router.use(type==='user'?authenticateUser:authenticateOwner);
  router.get('/',controller.list);
  router.post('/devices',controller.registerDevice);
  router.delete('/devices/:deviceId',controller.removeDevice);
  router.put('/:notificationId/read',controller.read);
  return router;
}
