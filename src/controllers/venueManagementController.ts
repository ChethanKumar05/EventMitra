import { Request, Response } from 'express';
import * as service from '../services/venueManagementService';
import { VenueActor, VenuePart, VenuePriceDropdown, ownerDropdownColumns } from '../types/venueManagement';
import { securityActor } from '../middleware/adminAuth';
import { ownerSessionToken } from '../middleware/ownerAuth';
import { success } from '../utils/response';
import { httpError } from '../utils/httpError';
import { handler, recordId } from './securityValidation';
import { managementListQuery } from './managementValidation';
import { managedVenueInput, managedVenueListQuery, venuePartSaveInput } from './venueManagementValidation';

export function venueManagementController(admin = false) {
  const actor = (req: Request, res: Response): VenueActor => admin
    ? { type: 'admin', actor: securityActor(req, res.locals.admin) }
    : { type: 'owner', ownerId: res.locals.owner.owner_id, token: ownerSessionToken(req) };
  return {
    list: handler(async (req, res) => success(res, 'Venues', await service.listManagedVenues(actor(req, res), managedVenueListQuery(req.query, admin)))),
    get: handler(async (req, res) => success(res, 'Venue with configuration', await service.getManagedVenue(actor(req, res), recordId(req.params.venueId)))),
    create: handler(async (req, res) => success(res, 'Venue created', await service.createManagedVenue(actor(req, res), managedVenueInput(req.body, admin, true)), 201)),
    update: handler(async (req, res) => {
      const id = recordId(req.params.venueId), input = managedVenueInput(req.body, admin);
      success(res, 'Venue updated', await service.updateManagedVenue(actor(req, res), id, input));
    }),
    remove: handler(async (req, res) => success(res, 'Venue marked deleted', await service.deleteManagedVenue(actor(req, res), recordId(req.params.venueId)))),
    owners: handler(async (req, res) => success(res, 'Venue owner options', await service.venueOwnerDropdown(managementListQuery(req.query, ownerDropdownColumns)))),
    priceDropdown: (part: VenuePriceDropdown) => handler(async (req, res) => {
      const id = recordId(req.params.venueId);
      if (Object.keys(req.query).length) httpError(400, 'Dropdowns use venue_id in the URL and accept no query parameters');
      success(res, 'Venue price options', await service.venuePriceDropdown(actor(req, res), id, part));
    }),
    savePart: (part: VenuePart) => handler(async (req, res) => {
      const id = recordId(req.params.venueId), { input, partId } = venuePartSaveInput(part, req.body);
      const saved = await service.writeVenuePart(actor(req, res), id, part, input, partId);
      success(res, saved.created ? 'Venue record created' : 'Venue record updated', saved.record, saved.created ? 201 : 200);
    }),
    removePart: (part: VenuePart) => handler(async (req, res) => success(res, 'Venue record deleted', await service.deleteVenuePart(actor(req, res), recordId(req.params.venueId), part, part === 'amenities' ? undefined : recordId(req.params.partId)))),
  };
}
