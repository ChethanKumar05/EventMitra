import ownerRoutes from './ownerRoutes';
import userRoutes from './userRoutes';
import personManagementRoutes from './personManagementRoutes';
import adminVenueRoutes from './adminVenueRoutes';
import { adminBookingRoutes } from './bookingRoutes';
import { notificationRoutes } from './notificationRoutes';
import securityRoutes from '../security/routes';
import { Router } from 'express';
import { pool } from '../config/database';
import venueRoutes from './venueRoutes';
import uploadRoutes from './uploadRoutes';
import { success } from '../utils/response';

const router = Router();
router.get('/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');
    success(res, 'healthy', { service: 'eventmitra-api', database: 'connected' });
  } catch (error) { next(error); }
});
router.use('/venues', venueRoutes);
router.use('/uploads',uploadRoutes);
router.use('/admin/bookings',adminBookingRoutes);
router.use('/admin/notifications',notificationRoutes('admin'));
router.use('/admin/venues', adminVenueRoutes);
router.use('/admin', personManagementRoutes);
router.use('/admin', securityRoutes);
router.use('/owner',ownerRoutes);
router.use('/user',userRoutes);
export default router;
