import { roleListQuery } from './listValidation';
import * as service from '../services/roleService';
import { RoleInput } from '../security/types';
import { securityActor } from '../middleware/adminAuth';
import { success } from '../utils/response';
import { handler, permissionIds, recordId, requestBody, uniqueName } from './securityValidation';
function validate(value: unknown, create = false): RoleInput {
  const body = requestBody(value, 'role_code');
  const input: RoleInput = {};
  if (create || body.role_type !== undefined) input.role_type = uniqueName(body.role_type, 'role_type', 100);
  if (body.permission_ids !== undefined) input.permission_ids = permissionIds(body.permission_ids);
  return input;
}
export const list = handler(async (req, res) => { success(res, 'roles', await service.listRoles(roleListQuery(req.query))); });
export const get = handler(async (req, res) => { success(res, 'roles', await service.getRole(recordId(req.params.id))); });
export const create = handler(async (req, res) => { const input = validate(req.body, true); success(res, 'Saved', await service.createRole(securityActor(req, res.locals.admin), input), 201); });
export const update = handler(async (req, res) => { const id = recordId(req.params.id), input = validate(req.body); success(res, 'Saved', await service.updateRole(securityActor(req, res.locals.admin), id, input)); });
export const remove = handler(async (req, res) => { success(res, 'Deleted', await service.deleteRole(securityActor(req, res.locals.admin), recordId(req.params.id))); });
