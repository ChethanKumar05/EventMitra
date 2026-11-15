import { handler, recordId } from './securityValidation';
import { discoveryQuery,venueDetailDate } from './bookingValidation';
import * as service from '../services/venueDiscoveryService';
import { success } from '../utils/response';
export const list = handler(async (req, res) => success(res, 'Bookable venues', await service.discoverVenues(discoveryQuery(req.query))));
export const get = handler(async (req, res) => success(res, 'Bookable venue', await service.getBookableVenue(recordId(req.params.venueId),venueDetailDate(req.query))));
