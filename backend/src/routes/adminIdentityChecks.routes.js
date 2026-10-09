const express = require('express');
const router = express.Router();
const controller = require('../controllers/identityCheck.controller');
const { protect, authorize, requireCapability } = require('../middleware/auth.middleware');

// Identity document checks: who has details that don't match. Admins only;
// the doctor or hospital never sees these.
router.use(protect);
router.use(authorize('admin'));

router.get('/', requireCapability('document.view'), controller.list);
router.get('/:userId', requireCapability('document.view'), controller.get);
router.post('/:userId/recheck', requireCapability('document.manage'), controller.recheck);
router.post('/:userId/dismiss', requireCapability('document.manage'), controller.dismiss);

module.exports = router;
