import { Router } from 'express';
import { getVenue, listVenues } from '../controllers/venueController';
const router = Router();
router.get('/', listVenues);
router.get('/:venueId', getVenue);
export default router;
