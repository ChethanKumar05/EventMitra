import { Request, Response } from 'express';
import * as service from '../services/bankAccountService';
import { AccountActor, PersonKind } from '../types/management';
import { securityActor } from '../middleware/adminAuth';
import { ownerSessionToken } from '../middleware/ownerAuth';
import { userSessionToken } from '../middleware/userAuth';
import { success } from '../utils/response';
import { handler, recordId } from './securityValidation';
import { bankAccountInput, defaultAccountInput, managementListQuery } from './managementValidation';

export function bankAccountController(kind: PersonKind, admin = false) {
  const context = (req: Request, res: Response): { personId: string; actor: AccountActor } => admin
    ? { personId: recordId(req.params.id), actor: { type: 'admin', actor: securityActor(req, res.locals.admin) } }
    : { personId: res.locals[kind][`${kind}_id`], actor: { type: kind, id: res.locals[kind][`${kind}_id`], token: kind === 'owner' ? ownerSessionToken(req) : userSessionToken(req) } };
  return {
    list: handler(async (req, res) => {
      const { personId, actor } = context(req, res), query = managementListQuery(req.query, service.bankColumns(kind));
      success(res, 'Accounts', await service.listBankAccounts(kind, personId, actor, query));
    }),
    get: handler(async (req, res) => {
      const { personId, actor } = context(req, res), id = recordId(req.params.accountId);
      success(res, 'Account', await service.getBankAccount(kind, personId, id, actor));
    }),
    create: handler(async (req, res) => {
      const { personId, actor } = context(req, res), input = bankAccountInput(req.body, true);
      success(res, 'Account added', await service.writeBankAccount(kind, personId, actor, input), 201);
    }),
    update: handler(async (req, res) => {
      const { personId, actor } = context(req, res), id = recordId(req.params.accountId);
      const input = admin ? bankAccountInput(req.body) : defaultAccountInput(req.body);
      success(res, 'Account updated', await service.writeBankAccount(kind, personId, actor, input, id));
    }),
  };
}
