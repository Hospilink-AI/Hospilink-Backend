const { getLogoBase64 } = require('./logo.util');

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

function earningsTemplate(data) {
    const logo = getLogoBase64();
    const user = data.user || {};

    return `
    <html>
    <head>
        <style>
            body {
                font-family: 'Segoe UI', sans-serif;
                background: #f5f7fb;
                padding: 30px;
            }

            .card {
                background: #fff;
                border-radius: 12px;
                padding: 25px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.08);
            }

            /* HEADER */
            .header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-bottom: 2px solid #e2e8f0;
                padding-bottom: 10px;
                margin-bottom: 15px;
            }

            .main-logo {
                width: 180px;
            }

            .doc-title {
                font-size: 18px;
                font-weight: 600;
                color: #1e293b;
            }

            .doc-sub {
                font-size: 12px;
                color: #64748b;
            }

            /* INFO GRID */
            .info-grid {
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 10px;
                margin-bottom: 20px;
            }

            .info-box {
                background: #f8fafc;
                padding: 10px;
                border-radius: 8px;
            }

            .info-box span {
                font-size: 11px;
                color: #64748b;
            }

            .info-box strong {
                display: block;
                font-size: 14px;
                color: #0f172a;
            }

            /* TABLE */
            table {
                width: 100%;
                border-collapse: separate;
                border-spacing: 0 8px;
            }

            th {
                text-align: left;
                font-size: 12px;
                color: #64748b;
            }

            td {
                padding: 12px;
            }

            tbody tr {
                background: #fff;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
                border-radius: 8px;
            }

            /* SUMMARY */
            .summary {
                display: flex;
                justify-content: space-between;
                margin-top: 20px;
                background: #f1f5f9;
                padding: 15px;
                border-radius: 10px;
            }

            .summary span {
                font-size: 12px;
                color: #64748b;
            }

            .summary strong {
                display: block;
                font-size: 16px;
            }

            .earnings strong {
                color: #16a34a;
            }

            /* FOOTER */
            .footer {
                margin-top: 20px;
                font-size: 12px;
                color: #64748b;
                text-align: center;
            }
        </style>
    </head>

    <body>
        <div class="card">

            <div class="header">
                <img src="${logo}" class="main-logo" />
                <div>
                    <div class="doc-title">Earnings Statement</div>
                    <div class="doc-sub">HospiLink Report</div>
                </div>
            </div>

            <div class="info-grid">
                <div class="info-box">
                    <span>Name</span>
                    <strong>${user.name || '-'}</strong>
                </div>

                <div class="info-box">
                    <span>Role</span>
                    <strong>${user.role || '-'}</strong>
                </div>

                <div class="info-box">
                    <span>Email</span>
                    <strong>${user.email || '-'}</strong>
                </div>

                <div class="info-box">
                    <span>Period</span>
                    <strong>${data.period || '-'}</strong>
                </div>
            </div>

            <table>
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Hospital</th>
                        <th>Role</th>
                        <th>Hrs</th>
                        <th>Amount</th>
                    </tr>
                </thead>

                <tbody>
                    ${(data.data || []).map(item => `
                        <tr>
                            <td>${new Date(item.dutyDate).toLocaleDateString('en-IN')}</td>
                            <td>${item.hospital}</td>
                            <td>${item.role}</td>
                            <td>${item.hours || 0}</td>
                            <td><b>₹${item.amount}</b></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>

            <div class="summary">
                <div>
                    <span>Duties</span>
                    <strong>${data.totalDuties}</strong>
                </div>
                <div>
                    <span>Hours</span>
                    <strong>${data.totalHours}</strong>
                </div>
                <div class="earnings">
                    <span>Total Earnings</span>
                    <strong>₹${data.totalEarnings}</strong>
                </div>
            </div>

            <div class="footer">
                Generated on ${new Date().toDateString()} <br/>
                This is a system-generated statement
            </div>

        </div>
    </body>
    </html>
    `;
}

function receiptTemplate(data) {
    const logo = getLogoBase64();

    return `
    <html>
    <head>
        <style>
            body {
                font-family: 'Segoe UI', sans-serif;
                padding: 30px;
                background: #f5f7fb;
            }

            .card {
                background: #fff;
                padding: 25px;
                border-radius: 12px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.08);
            }

            .header {
                text-align: center;
                margin-bottom: 15px;
            }

            .header img {
                width: 180px;
            }

            h2 {
                text-align: center;
                margin-bottom: 10px;
            }

            .section {
                margin-top: 15px;
                padding: 10px;
                border-left: 3px solid #2563eb;
                background: #f8fafc;
                border-radius: 6px;
            }

            p {
                margin: 6px 0;
            }

            .highlight {
                font-size: 18px;
                font-weight: bold;
                color: #16a34a;
            }
        </style>
    </head>

    <body>
        <div class="card">

            <!-- HEADER -->
            <div class="header">
                <img src="${logo}" />
            </div>

            <h2>Duty Receipt</h2>

            <!-- STAFF DETAILS -->
            <div class="section">
                <h4>Staff Details</h4>
                <p>Name: ${data.staff?.name || '-'}</p>
                <p>Email: ${data.staff?.email || '-'}</p>
                <p>Role: ${data.staff?.role || '-'}</p>
            </div>

            <!-- DUTY INFO -->
            <div class="section">
                <h4>Duty Info</h4>
                <p>Duty ID: ${data.dutyId || '-'}</p>
                <p>Hospital: ${data.hospital || '-'}</p>
            </div>
            <div class="section">
                <h4>Duty Summary</h4>
                <p>Role: ${data.summary?.role || '-'}</p>
                <p>Urgency: ${data.summary?.urgency || '-'}</p>
                <p>Date: ${data.summary?.date ? new Date(data.summary.date).toLocaleDateString() : '-'}</p>
                <p>Payment: ₹${data.summary?.payment || 0}</p>
            </div>

            <!-- TIMING -->
            <div class="section">
                <h4>Timing</h4>
                <p>Start: ${data.time?.startTime || '-'}</p>
                <p>End: ${data.time?.endTime || '-'}</p>
                <p>Duration: ${data.time?.duration || '-'}</p>
            </div>

            <!-- PAYMENT -->
            <div class="section">
                <h4>Payment</h4>
                <p class="highlight">₹${data.totalEarning || 0}</p>
                <p>Method: ${data.payment?.method || 'Unconfirmed'}</p>
                <p>Status: ${data.payment?.status || 'Unconfirmed by hospital'}</p>
                <p>Attested On: ${data.payment?.attestedAt ? new Date(data.payment.attestedAt).toLocaleString() : '-'}</p>
            </div>

            <!-- FOOTER -->
            <div class="section">
                <p style="font-size: 12px; color: #64748b;">
                    Generated on ${new Date().toDateString()} <br/>
                    This is a system-generated receipt
                </p>
            </div>

        </div>
    </body>
    </html>
    `;
}

module.exports = {
    earningsTemplate,
    receiptTemplate,
    activityLogsTemplate,
    activeDutiesTemplate
};