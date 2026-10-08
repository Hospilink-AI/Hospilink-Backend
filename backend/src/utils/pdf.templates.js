const { getLogoBase64 } = require('./logo.util');
// Doctor statement and receipt live in their own file, in the new brand
const { earningsTemplate, receiptTemplate } = require('./pdf.doctorTemplates');

function activityLogsTemplate(data) {
    const logo = getLogoBase64();
    const { logs = [], filters = {}, exportedAt } = data;

    const statusColor = (status) => ({
        SUCCESS: '#16a34a',
        FAILED: '#dc2626',
        CRITICAL: '#9333ea',
        WARNING: '#d97706'
    }[status] || '#64748b');

    const categoryColor = (category) => ({
        DUTY: '#2563eb',
        USER: '#0891b2',
        DOCUMENT: '#7c3aed',
        REVIEW: '#db2777',
        ADMIN: '#ea580c',
        SECURITY: '#dc2626',
        SYSTEM: '#64748b'
    }[category] || '#64748b');

    const rows = logs.map(log => `
        <tr>
            <td>${new Date(log.timestamp).toLocaleString('en-IN')}</td>
            <td>${log.actor?.name || '-'}</td>
            <td><span class="badge" style="background:${categoryColor(log.actor?.role)}">${log.actor?.role || '-'}</span></td>
            <td>${log.action?.replace(/_/g, ' ') || '-'}</td>
            <td><span class="badge" style="background:${categoryColor(log.category)}">${log.category || '-'}</span></td>
            <td>${log.target?.name || '-'}</td>
            <td>${log.location || '-'}</td>
            <td><span class="badge" style="background:${statusColor(log.status)}">${log.status || '-'}</span></td>
        </tr>
    `).join('');

    const activeFilters = Object.entries(filters)
        .filter(([, v]) => v)
        .map(([k, v]) => `<span class="filter-tag">${k}: <b>${v}</b></span>`)
        .join('');

    return `
    <html>
    <head>
        <style>
            body { font-family: 'Segoe UI', sans-serif; background: #f5f7fb; padding: 24px; font-size: 12px; }
            .card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; margin-bottom: 16px; }
            .main-logo { width: 150px; }
            .doc-title { font-size: 18px; font-weight: 700; color: #1e293b; }
            .doc-sub { font-size: 11px; color: #64748b; margin-top: 2px; }
            .meta { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; align-items: center; }
            .filter-tag { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; padding: 2px 8px; font-size: 11px; color: #475569; }
            .summary-bar { display: flex; gap: 16px; margin-bottom: 16px; }
            .summary-item { background: #f8fafc; border-radius: 8px; padding: 10px 16px; flex: 1; text-align: center; }
            .summary-item span { font-size: 11px; color: #64748b; display: block; }
            .summary-item strong { font-size: 20px; color: #0f172a; }
            table { width: 100%; border-collapse: collapse; }
            th { background: #f1f5f9; text-align: left; padding: 8px 10px; font-size: 11px; color: #475569; font-weight: 600; }
            td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; color: #334155; vertical-align: middle; }
            tr:last-child td { border-bottom: none; }
            .badge { color: #fff; border-radius: 4px; padding: 2px 7px; font-size: 10px; font-weight: 600; white-space: nowrap; }
            .footer { margin-top: 20px; font-size: 11px; color: #94a3b8; text-align: center; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="header">
                <img src="${logo}" class="main-logo" />
                <div>
                    <div class="doc-title">Activity Logs Report</div>
                    <div class="doc-sub">HospiLink Admin Export &nbsp;·&nbsp; ${new Date(exportedAt).toLocaleString('en-IN')}</div>
                </div>
            </div>

            ${activeFilters ? `<div class="meta"><span style="font-size:11px;color:#64748b;margin-right:4px;">Filters:</span>${activeFilters}</div>` : ''}

            <div class="summary-bar">
                <div class="summary-item"><span>Total Records</span><strong>${logs.length}</strong></div>
                <div class="summary-item"><span>Success</span><strong style="color:#16a34a">${logs.filter(l => l.status === 'SUCCESS').length}</strong></div>
                <div class="summary-item"><span>Failed</span><strong style="color:#dc2626">${logs.filter(l => l.status === 'FAILED').length}</strong></div>
                <div class="summary-item"><span>Critical</span><strong style="color:#9333ea">${logs.filter(l => l.status === 'CRITICAL').length}</strong></div>
            </div>

            <table>
                <thead>
                    <tr>
                        <th>Timestamp</th>
                        <th>Actor</th>
                        <th>Role</th>
                        <th>Action</th>
                        <th>Category</th>
                        <th>Target</th>
                        <th>Location</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>

            <div class="footer">
                Generated on ${new Date().toDateString()} &nbsp;·&nbsp; This is a system-generated report
            </div>
        </div>
    </body>
    </html>`;
}

function activeDutiesTemplate(data) {
    const logo = getLogoBase64();
    const { duties = [], filters = {}, summary = {}, exportedAt } = data;

    const statusColor = (status) => ({
        'assigned':    '#2563eb',
        'enroute':     '#d97706',
        'in-progress': '#16a34a'
    }[status] || '#64748b');

    const urgencyColor = (urgency) => ({
        'emergency': '#dc2626',
        'urgent':    '#d97706',
        'normal':    '#16a34a'
    }[urgency] || '#64748b');

    const rows = duties.map(d => `
        <tr>
            <td>${d.hospital?.name || '-'}</td>
            <td>${d.hospital?.city || '-'}</td>
            <td>${(d.role || '-').replace(/_/g, ' ').toUpperCase()}</td>
            <td>${d.staff?.name || '-'}</td>
            <td>${d.staff?.email || '-'}</td>
            <td>${d.timing?.date ? new Date(d.timing.date).toLocaleDateString('en-IN') : '-'}</td>
            <td>${d.timing?.startTime || '-'} – ${d.timing?.endTime || '-'}</td>
            <td><span class="badge" style="background:${statusColor(d.status?.status)}">${(d.status?.status || '-').toUpperCase()}</span></td>
            <td><span class="badge" style="background:${urgencyColor(d.timing?.urgency)}">${(d.timing?.urgency || '-').toUpperCase()}</span></td>
            <td>${d.distance?.distanceText || '-'}</td>
            <td>${d.distance?.estimatedTimeText || '-'}</td>
            <td>${d.offeredRate ? '₹' + d.offeredRate : '-'}</td>
        </tr>
    `).join('');

    const activeFilters = Object.entries(filters)
        .filter(([, v]) => v && v !== 'all')
        .map(([k, v]) => `<span class="filter-tag">${k}: <b>${v}</b></span>`)
        .join('');

    return `
    <html>
    <head>
        <style>
            body { font-family: 'Segoe UI', sans-serif; background: #f5f7fb; padding: 24px; font-size: 11px; }
            .card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; margin-bottom: 16px; }
            .main-logo { width: 140px; }
            .doc-title { font-size: 18px; font-weight: 700; color: #1e293b; }
            .doc-sub { font-size: 11px; color: #64748b; margin-top: 2px; }
            .meta { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; align-items: center; }
            .filter-tag { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; padding: 2px 8px; font-size: 11px; color: #475569; }
            .summary-bar { display: flex; gap: 12px; margin-bottom: 16px; }
            .summary-item { background: #f8fafc; border-radius: 8px; padding: 10px 14px; flex: 1; text-align: center; }
            .summary-item span { font-size: 10px; color: #64748b; display: block; }
            .summary-item strong { font-size: 18px; color: #0f172a; }
            table { width: 100%; border-collapse: collapse; }
            th { background: #f1f5f9; text-align: left; padding: 7px 8px; font-size: 10px; color: #475569; font-weight: 600; white-space: nowrap; }
            td { padding: 7px 8px; border-bottom: 1px solid #f1f5f9; color: #334155; vertical-align: middle; }
            tr:last-child td { border-bottom: none; }
            .badge { color: #fff; border-radius: 4px; padding: 2px 6px; font-size: 9px; font-weight: 700; white-space: nowrap; }
            .footer { margin-top: 20px; font-size: 10px; color: #94a3b8; text-align: center; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="header">
                <img src="${logo}" class="main-logo" />
                <div>
                    <div class="doc-title">Active Duties Report</div>
                    <div class="doc-sub">HospiLink Admin Export &nbsp;·&nbsp; ${new Date(exportedAt).toLocaleString('en-IN')}</div>
                </div>
            </div>

            ${activeFilters ? `<div class="meta"><span style="font-size:11px;color:#64748b;margin-right:4px;">Filters:</span>${activeFilters}</div>` : ''}

            <div class="summary-bar">
                <div class="summary-item"><span>Total Active</span><strong>${summary.totalActiveDuties || duties.length}</strong></div>
                <div class="summary-item"><span>Assigned</span><strong style="color:#2563eb">${summary.assignedCount || 0}</strong></div>
                <div class="summary-item"><span>En Route</span><strong style="color:#d97706">${summary.enrouteCount || 0}</strong></div>
                <div class="summary-item"><span>In Progress</span><strong style="color:#16a34a">${summary.inProgressCount || 0}</strong></div>
            </div>

            <table>
                <thead>
                    <tr>
                        <th>Hospital</th>
                        <th>City</th>
                        <th>Role</th>
                        <th>Staff Name</th>
                        <th>Staff Email</th>
                        <th>Date</th>
                        <th>Shift</th>
                        <th>Status</th>
                        <th>Urgency</th>
                        <th>Distance</th>
                        <th>ETA</th>
                        <th>Rate</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>

            <div class="footer">
                Generated on ${new Date().toDateString()} &nbsp;·&nbsp; This is a system-generated report
            </div>
        </div>
    </body>
    </html>`;
}

module.exports = {
    earningsTemplate,
    receiptTemplate,
    activityLogsTemplate,
    activeDutiesTemplate
};