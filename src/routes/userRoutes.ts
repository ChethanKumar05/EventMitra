import { Router } from 'express';
import * as auth from '../controllers/userAuthController';
import { authenticateUser, userAuthHeaders } from '../middleware/userAuth';

const router = Router();
router.use(userAuthHeaders);
router.post('/auth/signup', auth.signup);
router.post('/auth/login', auth.login);
router.post('/auth/verify-otp', auth.verifyOtp);
router.post('/auth/resend-otp', auth.resendOtp);
router.get('/auth/me', authenticateUser, auth.me);
router.post('/auth/logout', auth.logout);
export default router;
