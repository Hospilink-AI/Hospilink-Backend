const { asyncHandler } = require('../middleware/error.middleware');
const dutyInviteService = require('../services/dutyInvite.service');

// GET /api/hospital/favourites
exports.listFavourites = asyncHandler(async (req, res) => {
    const favourites = await dutyInviteService.listFavourites(req.user.id);
    res.status(200).json({ success: true, favourites });
});


// POST /api/hospital/favourites/:staffId
exports.addFavourite = asyncHandler(async (req, res) => {
    await dutyInviteService.addFavourite(req.user.id, req.params.staffId);
    res.status(200).json({ success: true, message: 'Added to favourites' });
});


// DELETE /api/hospital/favourites/:staffId
exports.removeFavourite = asyncHandler(async (req, res) => {
    await dutyInviteService.removeFavourite(req.user.id, req.params.staffId);
    res.status(200).json({ success: true, message: 'Removed from favourites' });
});


// GET /api/duties/invite-candidates?role=&date=&start_time=&end_time=
exports.getInviteCandidates = asyncHandler(async (req, res) => {
    const candidates = await dutyInviteService.getCandidates(req.user.id, req.query);
    res.status(200).json({ success: true, ...candidates });
});
