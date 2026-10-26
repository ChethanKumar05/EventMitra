import { Router } from 'express';
import { personManagementController } from '../controllers/personManagementController';
import { bankAccountController } from '../controllers/bankAccountController';
import { authenticateAdmin, securityHeaders } from '../middleware/adminAuth';
import { requireManagementPermission } from '../middleware/managementAuth';

const router = Router();
router.use(['/users', '/owners'], securityHeaders, authenticateAdmin);
const users = personManagementController('user'), owners = personManagementController('owner');
const userAccounts = bankAccountController('user', true), ownerAccounts = bankAccountController('owner', true);

router.get('/users', requireManagementPermission('user', 'read'), users.list);
router.get('/users/:id', requireManagementPermission('user', 'read'), users.get);
router.post('/users', requireManagementPermission('user', 'create'), users.create);
router.put('/users/:id', requireManagementPermission('user', 'edit'), users.update);
router.delete('/users/:id', requireManagementPermission('user', 'delete'), users.remove);
router.get('/users/:id/accounts', requireManagementPermission('user', 'read'), userAccounts.list);
router.get('/users/:id/accounts/:accountId', requireManagementPermission('user', 'read'), userAccounts.get);
router.post('/users/:id/accounts', requireManagementPermission('user', 'create'), userAccounts.create);
router.put('/users/:id/accounts/:accountId', requireManagementPermission('user', 'edit'), userAccounts.update);

router.get('/owners', requireManagementPermission('owner', 'read'), owners.list);
router.get('/owners/:id', requireManagementPermission('owner', 'read'), owners.get);
router.post('/owners', requireManagementPermission('owner', 'create'), owners.create);
router.put('/owners/:id', requireManagementPermission('owner', 'edit'), owners.update);
router.delete('/owners/:id', requireManagementPermission('owner', 'delete'), owners.remove);
router.get('/owners/:id/accounts', requireManagementPermission('owner', 'read'), ownerAccounts.list);
router.get('/owners/:id/accounts/:accountId', requireManagementPermission('owner', 'read'), ownerAccounts.get);
router.post('/owners/:id/accounts', requireManagementPermission('owner', 'create'), ownerAccounts.create);
router.put('/owners/:id/accounts/:accountId', requireManagementPermission('owner', 'edit'), ownerAccounts.update);
export default router;
