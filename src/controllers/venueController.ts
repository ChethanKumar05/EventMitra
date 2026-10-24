import { RequestHandler } from 'express';
import { findActiveVenueById, listActiveVenues } from '../services/venueService';
import { failure, success } from '../utils/response';

export const listVenues: RequestHandler = async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      failure(res, 'page must be >= 1 and limit must be 1..100', 400);
      return;
    }
    const data = await listActiveVenues(limit, (page - 1) * limit);
    success(res, 'Venues fetched', { page, limit, items: data });
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
