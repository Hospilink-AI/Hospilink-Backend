/**
    * Pagination utility functions
    * Default limit: 10 items per page
*/

const DEFAULT_PAGE_LIMIT = 10;


// Calculate pagination parameters
function getPaginationParams(page = 1, limit = DEFAULT_PAGE_LIMIT) {
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || DEFAULT_PAGE_LIMIT);
    
    const offset = (pageNum - 1) * limitNum;
    
    return {
        page: pageNum,
        limit: limitNum,
        offset,
        skip: offset // Alternative name for offset
    };
}


// Calculate pagination metadata
function getPaginationMeta(totalItems, page, limit = DEFAULT_PAGE_LIMIT) {
    const totalPages = Math.ceil(totalItems / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;
    
    return {
        totalItems,
        totalPages,
        currentPage: page,
        itemsPerPage: limit,
        hasNextPage,
        hasPrevPage,
        nextPage: hasNextPage ? page + 1 : null,
        prevPage: hasPrevPage ? page - 1 : null
    };
}


// Paginate an array of data
function paginateArray(data, page = 1, limit = DEFAULT_PAGE_LIMIT) {
    const { offset, limit: limitNum, page: pageNum } = getPaginationParams(page, limit);
    const paginatedData = data.slice(offset, offset + limitNum);
    
    return {
        data: paginatedData,
        pagination: getPaginationMeta(data.length, pageNum, limitNum)
    };
}


// Generate page numbers for pagination UI
function generatePageNumbers(currentPage, totalPages, maxVisible = 5) {
    if (totalPages <= maxVisible) {
        return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    
    const pages = [];
    const halfVisible = Math.floor(maxVisible / 2);
    
    let startPage = Math.max(1, currentPage - halfVisible);
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    
    if (endPage - startPage < maxVisible - 1) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }
    
    // Add first page and ellipsis if needed
    if (startPage > 1) {
        pages.push(1);
        if (startPage > 2) {
        pages.push('...');
        }
    }
    
    // Add visible pages
    for (let i = startPage; i <= endPage; i++) {
        pages.push(i);
    }
    
    // Add ellipsis and last page if needed
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
        pages.push('...');
        }
        pages.push(totalPages);
    }
    
    return pages;
}

module.exports = {
    DEFAULT_PAGE_LIMIT,
    getPaginationParams,
    getPaginationMeta,
    paginateArray,
    generatePageNumbers
};