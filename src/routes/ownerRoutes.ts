import { Router } from 'express';
import * as auth from '../controllers/ownerAuthController';
import { authenticateOwner,ownerAuthHeaders } from '../middleware/ownerAuth';
const router=Router();
router.use(ownerAuthHeaders);
router.post('/auth/login',auth.login);
router.get('/auth/me',authenticateOwner,auth.me);
router.post('/auth/logout',auth.logout);
export default router;
