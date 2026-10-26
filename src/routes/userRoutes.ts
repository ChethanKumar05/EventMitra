import { Router } from 'express';
import * as auth from '../controllers/userAuthController';
import { bankAccountController } from '../controllers/bankAccountController';
import { authenticateUser, userAuthHeaders } from '../middleware/userAuth';

const router = Router();
router.use(userAuthHeaders);
router.post('/auth/signup', auth.signup);
router.post('/auth/login', auth.login);
router.post('/auth/verify-otp', auth.verifyOtp);
router.post('/auth/resend-otp', auth.resendOtp);
router.get('/auth/me', authenticateUser, auth.me);
router.post('/auth/logout', auth.logout);
const accounts = bankAccountController('user');
router.get('/accounts', authenticateUser, accounts.list);
router.get('/accounts/:accountId', authenticateUser, accounts.get);
router.post('/accounts', authenticateUser, accounts.create);
router.put('/accounts/:accountId', authenticateUser, accounts.update);
export default router;
