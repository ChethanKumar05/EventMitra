import * as service from '../services/personManagementService';
import { PersonKind, profileListColumns } from '../types/management';
import { securityActor } from '../middleware/adminAuth';
import { success } from '../utils/response';
import { handler, recordId } from './securityValidation';
import { managementListQuery, managementProfileInput } from './managementValidation';

export function personManagementController(kind: PersonKind) {
  return {
    list: handler(async (req, res) => success(res, `${kind}s`, await service.listPeople(kind, managementListQuery(req.query, profileListColumns[kind])))),
    get: handler(async (req, res) => success(res, kind, await service.getPerson(kind, recordId(req.params.id)))),
    create: handler(async (req, res) => {
      const input = managementProfileInput(kind, req.body, true);
      success(res, 'Created', await service.writePerson(kind, 'create', securityActor(req, res.locals.admin), input), 201);
    }),
    update: handler(async (req, res) => {
      const id = recordId(req.params.id), input = managementProfileInput(kind, req.body);
      success(res, 'Updated', await service.writePerson(kind, 'update', securityActor(req, res.locals.admin), input, id));
    }),
    remove: handler(async (req, res) => success(res, 'Marked deleted', await service.writePerson(kind, 'delete', securityActor(req, res.locals.admin), {}, recordId(req.params.id)))),
  };
}
