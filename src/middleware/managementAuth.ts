import { RequestHandler } from 'express';
import { assertManagementActor } from '../services/managementAuthorizationService';
import { ManagementAction, PersonKind } from '../types/management';
import { securityActor } from './adminAuth';

export function requireManagementPermission(kind: PersonKind, action: ManagementAction): RequestHandler {
  return (req, res, next) => {
    void assertManagementActor(securityActor(req, res.locals.admin), kind, action).then(() => next()).catch(next);
  };
}
