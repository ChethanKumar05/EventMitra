import { permissionListQuery } from './listValidation';
import * as service from '../services/permissionService';
import { PermissionInput } from '../security/types';
import { securityActor } from '../middleware/adminAuth';
import { success } from '../utils/response';
import { httpError } from '../utils/httpError';
import { handler, recordId, requestBody, text } from './securityValidation';
function validate(value: unknown, create = false): PermissionInput {
  const body = requestBody(value, 'permission_code');
  const input: PermissionInput = {};
  if (create || body.permission_name !== undefined) input.permission_name = text(body.permission_name, 'permission_name');
  if (create || body.permission_key !== undefined) {
    input.permission_key = text(body.permission_key, 'permission_key', 100);
    if (!/^[a-z][a-z0-9_.:-]*$/.test(input.permission_key)) httpError(400, 'Invalid permission_key');
  }
  return input;
}
export const list = handler(async (req, res) => { success(res, 'permissions', await service.listPermissions(permissionListQuery(req.query))); });
export const get = handler(async (req, res) => { success(res, 'permissions', await service.getPermission(recordId(req.params.id))); });
export const create = handler(async (req, res) => { const input = validate(req.body, true); success(res, 'Saved', await service.createPermission(securityActor(req, res.locals.admin), input), 201); });
export const update = handler(async (req, res) => { const id = recordId(req.params.id), input = validate(req.body); success(res, 'Saved', await service.updatePermission(securityActor(req, res.locals.admin), id, input)); });
export const remove = handler(async (req, res) => { success(res, 'Deleted', await service.deletePermission(securityActor(req, res.locals.admin), recordId(req.params.id))); });
