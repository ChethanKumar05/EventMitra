import { RequestHandler } from 'express';
import { findActiveVenueById, listVenues as listVenueRecords } from '../services/venueService';
import { failure, success } from '../utils/response';
import { venueListQuery } from './listValidation';

export const listVenues: RequestHandler = async (req, res, next) => {
  try {
    const query = venueListQuery(req.query);
    success(res, 'Venues fetched', await listVenueRecords(query));
  } catch (error) { next(error); }
};

export const getVenue: RequestHandler = async (req, res, next) => {
  try {
    const venueId = req.params.venueId;
    if (!venueId) { failure(res, 'Missing venue ID', 400); return; }
    const data = await findActiveVenueById(venueId);
    if (!data) { failure(res, 'Venue not found', 404); return; }
    success(res, 'Venue fetched', data);
  } catch (error) { next(error); }
};
