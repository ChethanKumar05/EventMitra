import ownerRoutes from './ownerRoutes';
import userRoutes from './userRoutes';
import securityRoutes from '../security/routes';
import { Router } from 'express';
import { pool } from '../config/database';
import venueRoutes from './venueRoutes';
import { success } from '../utils/response';

const router = Router();
router.get('/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1');
    success(res, 'healthy', { service: 'eventmitra-api', database: 'connected' });
  } catch (error) { next(error); }
});
router.use('/venues', venueRoutes);
router.use('/admin', securityRoutes);
router.use('/owner',ownerRoutes);
router.use('/user',userRoutes);
export default router;
