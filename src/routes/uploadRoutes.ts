import { Router } from 'express';
import { uploadFile } from '../controllers/uploadController';
import { authenticateUpload,uploadSecurityHeaders } from '../middleware/uploadAuth';

const router=Router();
router.post('/',uploadSecurityHeaders,authenticateUpload,uploadFile);
export default router;
