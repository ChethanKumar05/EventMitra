import { Router } from 'express';
import { venueManagementController } from '../controllers/venueManagementController';
import { authenticateOwner } from '../middleware/ownerAuth';

const router = Router(), venues = venueManagementController();
router.use(authenticateOwner);
router.post('/', venues.create);
router.get('/', venues.list);
router.get('/:venueId', venues.get);
router.put('/:venueId', venues.update);
router.get('/:venueId/type-slots/dropdown', venues.priceDropdown('type-slots'));
router.get('/:venueId/decorations/dropdown', venues.priceDropdown('decorations'));
router.get('/:venueId/meals/dropdown', venues.priceDropdown('meals'));
router.post('/:venueId/type-slots', venues.savePart('type-slots'));
router.put('/:venueId/amenities', venues.savePart('amenities'));
router.post('/:venueId/prices', venues.savePart('prices'));
router.post('/:venueId/decorations', venues.savePart('decorations'));
router.post('/:venueId/meals', venues.savePart('meals'));
export default router;
