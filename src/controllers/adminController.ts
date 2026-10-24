import { adminListQuery } from './listValidation';
import * as service from '../services/adminService';
import { AdminInput } from '../security/types';
import { securityActor } from '../middleware/adminAuth';
import { success } from '../utils/response';
import { httpError } from '../utils/httpError';
import { email, username, phone, handler, password, recordId, requestBody, text } from './securityValidation';
function validate(value: unknown, create = false): AdminInput {
  const body = requestBody(value, 'admin_code');
  const input: AdminInput = {};
  if(body.department!==undefined)input.department=body.department===null?null:text(body.department,'department',100);
  if(body.admin_phone_number!==undefined)input.admin_phone_number=body.admin_phone_number===null?null:phone(body.admin_phone_number);
  if(create||body.admin_username!==undefined)input.admin_username=username(body.admin_username);
  if (create || body.admin_name !== undefined) input.admin_name = text(body.admin_name, 'admin_name');
  if (create || body.admin_email !== undefined) input.admin_email = email(body.admin_email);
  if (create || body.role_id !== undefined) input.role_id = recordId(body.role_id);
  if (create || body.password !== undefined) input.password = password(body.password);
  if (body.status !== undefined) {
    if (!['active','reject','block','delete'].includes(body.status as string)) httpError(400, 'Invalid status');
    input.status = body.status as AdminInput['status'];
  }
  if (body.is_super_admin !== undefined) {
    if (typeof body.is_super_admin !== 'boolean') httpError(400, 'Invalid is_super_admin');
    input.is_super_admin = body.is_super_admin;
  }
  return input;
}
export const list = handler(async (req, res) => { success(res, 'admins', await service.listAdmins(adminListQuery(req.query))); });
export const get = handler(async (req, res) => { success(res, 'admins', await service.getAdmin(recordId(req.params.id))); });
export const create = handler(async (req, res) => { const input = validate(req.body, true); success(res, 'Saved', await service.createAdmin(securityActor(req, res.locals.admin), input), 201); });
export const update = handler(async (req, res) => { const id = recordId(req.params.id), input = validate(req.body); success(res, 'Saved', await service.updateAdmin(securityActor(req, res.locals.admin), id, input)); });
export const remove = handler(async (req, res) => { success(res, 'Deleted', await service.deleteAdmin(securityActor(req, res.locals.admin), recordId(req.params.id))); });
