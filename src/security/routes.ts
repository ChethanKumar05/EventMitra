import * as modules from '../controllers/moduleController';
import * as adminPermissions from '../controllers/adminPermissionController';
import { Router } from 'express';
import * as auth from '../controllers/adminAuthController';
import * as admins from '../controllers/adminController';
import * as roles from '../controllers/roleController';
import * as permissions from '../controllers/permissionController';
import { authenticateAdmin, requireSecurityRead, requireSuperAdmin, securityHeaders } from '../middleware/adminAuth';

const router = Router();
router.use(securityHeaders);
router.post('/auth/login', auth.login);
router.use(authenticateAdmin);
router.get('/auth/me', auth.me);
router.post('/auth/logout', auth.logout);

router.get('/admins', requireSecurityRead('admins'), admins.list);
router.get('/admins/:id', requireSecurityRead('admins'), admins.get);
router.post('/admins', requireSuperAdmin, admins.create);
router.put('/admins/:id', requireSuperAdmin, admins.update);
router.delete('/admins/:id', requireSuperAdmin, admins.remove);

router.get('/roles', requireSecurityRead('roles'), roles.list);
router.get('/roles/:id', requireSecurityRead('roles'), roles.get);
router.post('/roles', requireSuperAdmin, roles.create);
router.put('/roles/:id', requireSuperAdmin, roles.update);
router.delete('/roles/:id', requireSuperAdmin, roles.remove);

router.get('/permissions', requireSecurityRead('permissions'), permissions.list);
router.get('/permissions/:id', requireSecurityRead('permissions'), permissions.get);
router.post('/permissions', requireSuperAdmin, permissions.create);
router.put('/permissions/:id', requireSuperAdmin, permissions.update);
router.delete('/permissions/:id', requireSuperAdmin, permissions.remove);
router.get('/modules', requireSecurityRead('modules'), modules.list);
router.get('/modules/:id', requireSecurityRead('modules'), modules.get);
router.post('/modules', requireSuperAdmin, modules.create);
router.put('/modules/:id', requireSuperAdmin, modules.update);
router.delete('/modules/:id', requireSuperAdmin, modules.remove);
router.get('/admin-permissions', requireSecurityRead('admin-permissions'), adminPermissions.list);
router.get('/admin-permissions/:id', requireSecurityRead('admin-permissions'), adminPermissions.get);
router.post('/admin-permissions', requireSuperAdmin, adminPermissions.upsert);
router.delete('/admin-permissions/:id', requireSuperAdmin, adminPermissions.remove);
router.get('/admins/:adminId/permissions', requireSuperAdmin, adminPermissions.matrix);
router.put('/admins/:adminId/permissions', requireSuperAdmin, adminPermissions.replace);
export default router;
