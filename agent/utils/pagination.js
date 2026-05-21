/**
 * Pagination utility — agent-local copy
 * Copied from src/utils/pagination.js to make agent self-contained.
 */

const DEFAULT_PAGE_LIMIT = 10;

function getPaginationParams(page = 1, limit = DEFAULT_PAGE_LIMIT) {
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || DEFAULT_PAGE_LIMIT);
    const offset = (pageNum - 1) * limitNum;
    return { page: pageNum, limit: limitNum, offset, skip: offset };
}

function getPaginationMeta(totalItems, page, limit = DEFAULT_PAGE_LIMIT) {
    const totalPages = Math.ceil(totalItems / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;
    return {
        totalItems, totalPages, currentPage: page, itemsPerPage: limit,
        hasNextPage, hasPrevPage,
        nextPage: hasNextPage ? page + 1 : null,
        prevPage: hasPrevPage ? page - 1 : null
    };
}

module.exports = { DEFAULT_PAGE_LIMIT, getPaginationParams, getPaginationMeta };
