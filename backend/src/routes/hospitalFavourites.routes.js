const express = require('express');
const router = express.Router();
const dutyInviteController = require('../controllers/dutyInvite.controller');
const { protect, authorize, checkSuspension } = require('../middleware/auth.middleware');
const { requireHospitalVerification } = require('../middleware/accountsVerification.middleware');
const { validateObjectId } = require('../middleware/validation.middleware');

// A hospital's favourite doctors, used to invite them to duties directly
router.use(protect);
router.use(checkSuspension);
router.use(authorize('hospital'));
router.use(requireHospitalVerification);

router.get('/', dutyInviteController.listFavourites);
router.post('/:staffId', validateObjectId('staffId'), dutyInviteController.addFavourite);
router.delete('/:staffId', validateObjectId('staffId'), dutyInviteController.removeFavourite);

module.exports = router;
