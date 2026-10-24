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
export default router;
