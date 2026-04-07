const { getLogoBase64 } = require('./logo.util');

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
    receiptTemplate
};