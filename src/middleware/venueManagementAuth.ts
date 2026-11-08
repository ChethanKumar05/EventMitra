import { RequestHandler } from 'express';
import { VenuePart, venuePartIdFields } from '../types/venueManagement';
import { requireManagementPermission } from './managementAuth';

export function requireVenuePartSavePermission(part: Exclude<VenuePart, 'amenities'>): RequestHandler {
  return (req, res, next) => {
    // The controller validates this ID; the service rechecks the same action in its transaction.
    const updating = req.body != null && req.body[venuePartIdFields[part]] != null;
    requireManagementPermission('venue', updating ? 'edit' : 'create')(req, res, next);
  };
}
