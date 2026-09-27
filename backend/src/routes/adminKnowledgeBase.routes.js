const express = require('express');
const router = express.Router();
const adminKnowledgeBaseController = require('../controllers/adminKnowledgeBase.controller');
const { protect, authorize, requireCapability } = require('../middleware/auth.middleware');
const { validatePagination, validateObjectId, validateKnowledgeBaseArticle } = require('../middleware/validation.middleware');

router.use(protect);
router.use(authorize('admin'));

router.get('/', requireCapability('knowledgeBase.manage'), validatePagination, adminKnowledgeBaseController.list);
router.get('/:id', requireCapability('knowledgeBase.manage'), validateObjectId('id'), adminKnowledgeBaseController.getById);
router.post('/', requireCapability('knowledgeBase.manage'), validateKnowledgeBaseArticle, adminKnowledgeBaseController.create);
router.patch('/:id', requireCapability('knowledgeBase.manage'), validateObjectId('id'), validateKnowledgeBaseArticle, adminKnowledgeBaseController.update);
router.patch('/:id/deactivate', requireCapability('knowledgeBase.manage'), validateObjectId('id'), adminKnowledgeBaseController.deactivate);
router.patch('/:id/reactivate', requireCapability('knowledgeBase.manage'), validateObjectId('id'), adminKnowledgeBaseController.reactivate);

module.exports = router;
