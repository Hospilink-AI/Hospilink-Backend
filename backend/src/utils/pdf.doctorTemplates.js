// Doctor earnings statement and duty receipt in the HospiLink brand (navy band,
// Manrope, payment status per duty). Print with waitUntil 'networkidle0' so
// Manrope loads; without it the PDF falls back to the system sans.
const fs = require('fs');
const path = require('path');

const LOGO = fs.readFileSync(path.join(__dirname, '../assets/brand/hospilink-lockup-horizontal-white.svg'), 'utf8')
    .replace(/width="\d+" height="\d+"/, 'height="34"');

const ROLE = {
    rmo: 'RMO', icu_nurse: 'ICU Nurse', staff_nurse: 'Staff Nurse', ward_nurse: 'Ward Nurse', ot_nurse: 'OT Nurse',
    anesthetist: 'Anesthetist', lab_technician: 'Lab Technician', general_physician: 'General Physician', emergency_doctor: 'Emergency Doctor'
};
const role = (r) => ROLE[r] || String(r || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || '—';
const rs = (n) => (typeof n === 'number' && Number.isFinite(n) ? '₹' + Math.round(n).toLocaleString('en-IN') : '—');
const date = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');
const time = (hhmm) => {
    if (!hhmm) return '—';
    const [h, m] = hhmm.split(':').map(Number);
    const suffix = h < 12 ? 'AM' : 'PM';
    return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${suffix}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Receipt payment.status (as the duty service words it) to label and pill style
const STATUS = {
    Paid: ['Paid', 'paid'],
    'Will Pay Later': ['Hospital will pay later', 'later'],
    'Unconfirmed by hospital': ['Not confirmed by hospital', 'unconfirmed']
};
// Statement rows carry paymentStatus as 'paid' | 'pending' | 'unconfirmed'
const ROW_STATUS = { paid: STATUS.Paid, pending: STATUS['Will Pay Later'], unconfirmed: STATUS['Unconfirmed by hospital'] };
const METHOD = { upi: 'UPI', cash: 'Cash', bank: 'Bank transfer', bank_transfer: 'Bank transfer', will_pay_later: 'Pay later' };

const BASE = `
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&display=swap">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Manrope, system-ui, -apple-system, 'Segoe UI', sans-serif; color: #0E1E3A; background: #fff; font-size: 12px; line-height: 1.5; }
  .num { font-variant-numeric: tabular-nums; }
  .band { background: #0E1E3A; color: #fff; padding: 36px 44px 30px; position: relative; overflow: hidden; }
  .band svg.arcs { position: absolute; right: -60px; bottom: -40px; opacity: .5; }
  .band .top { display: flex; justify-content: space-between; align-items: flex-start; }
  .band h1 { font-size: 26px; font-weight: 800; letter-spacing: -.4px; margin-top: 26px; }
  .band .sub { color: #B7C4DE; font-size: 12.5px; margin-top: 2px; }
  .doc { text-align: right; color: #B7C4DE; font-size: 11px; }
  .doc b { color: #fff; font-weight: 700; display: block; font-size: 12px; }
  .wrap { padding: 28px 44px 36px; }
  .who { display: flex; gap: 12px; margin-bottom: 22px; }
  .who > div { flex: 1; background: #F0F2F7; border-radius: 14px; padding: 12px 14px; }
  .lab { color: #5A6580; font-size: 10.5px; font-weight: 600; }
  .val { font-weight: 700; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #5A6580; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; padding: 0 10px 8px; border-bottom: 1px solid #DCE3F0; }
  td { padding: 11px 10px; border-bottom: 1px solid #EEF1F7; vertical-align: top; }
  td.r, th.r { text-align: right; }
  tr { page-break-inside: avoid; }
  .muted { color: #5A6580; font-size: 11px; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 99px; font-size: 10.5px; font-weight: 700; }
  .pill.paid { background: #E3F3EA; color: #0B5A33; } .pill.later { background: #FEF3DC; color: #7A4E00; } .pill.unconfirmed { background: #EEF1F7; color: #414D64; }
  .totals { display: flex; gap: 12px; margin-top: 20px; }
  .totals > div { flex: 1; border-radius: 16px; padding: 14px 16px; background: #E6EDFA; }
  .totals > div.big { background: #0E1E3A; color: #fff; flex: 1.4; }
  .totals .lab { color: inherit; opacity: .75; }
  .totals .v { font-size: 20px; font-weight: 800; letter-spacing: -.3px; }
  .note { margin-top: 22px; color: #5A6580; font-size: 10.5px; display: flex; justify-content: space-between; border-top: 1px solid #DCE3F0; padding-top: 12px; }
</style>`;

const ARCS = `<svg class="arcs" width="300" height="150" viewBox="0 0 200 100">${[18, 35, 52, 69, 86]
    .map((r, i) => `<path d="M ${100 - r} 100 A ${r} ${r} 0 0 1 ${100 + r} 100" fill="none" stroke="#82A5EA" stroke-width="${i ? 3 : 5}" stroke-linecap="round" opacity="${i ? Math.max(0.12, 0.62 - i * 0.12) : 1}"/>`)
    .join('')}</svg>`;

// data: { user{name,email}, period, totalEarnings, totalDuties, totalHours,
//         data[{dutyDate, hospital, role, amount, hours, rate?, paymentStatus?}] }
function earningsTemplate(data) {
    const u = data.user || {};
    const rows = (data.data || [])
        .map((d) => {
            const st = ROW_STATUS[d.paymentStatus] || STATUS[d.paymentStatus];
            return `<tr>
        <td class="num">${date(d.dutyDate)}</td>
        <td><b>${esc(d.hospital)}</b><div class="muted">${esc(role(d.role))}</div></td>
        <td class="num">${esc(d.hours)}${d.rate ? `<div class="muted">${rs(d.rate)}/hr</div>` : ''}</td>
        <td>${st ? `<span class="pill ${st[1]}">${st[0]}</span>` : ''}</td>
        <td class="r num"><b>${rs(d.amount)}</b></td>
      </tr>`;
        })
        .join('');
    return `<html><head><meta charset="utf-8">${BASE}</head><body>
  <div class="band">${ARCS}
    <div class="top">${LOGO}<div class="doc"><b>Earnings statement</b>${esc(data.period)}</div></div>
    <h1>${esc(u.name)}</h1><div class="sub">${esc(u.email)}</div>
  </div>
  <div class="wrap">
    <table>
      <thead><tr><th>Date</th><th>Hospital and role</th><th>Hours</th><th>Payment</th><th class="r">Amount</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No completed duties in this period.</td></tr>'}</tbody>
    </table>
    <div class="totals">
      <div><div class="lab">Duties</div><div class="v num">${data.totalDuties ?? 0}</div></div>
      <div><div class="lab">Hours</div><div class="v num">${esc(data.totalHours)}</div></div>
      <div class="big"><div class="lab">Total earned</div><div class="v num">${rs(data.totalEarnings)}</div></div>
    </div>
    <div class="note"><span>Hospitals pay doctors directly. Payment status is as recorded by each hospital.</span><span>Generated ${date(new Date())} · HospiLink</span></div>
  </div></body></html>`;
}

// data: { staff{name,email}, dutyId, hospital, summary{role,date,payment}, totalEarning,
//         time{startTime,endTime,duration}, payment{method,status,attestedAt}, rate? }
function receiptTemplate(data) {
    const s = data.staff || {};
    const st = STATUS[data.payment?.status] || STATUS['Unconfirmed by hospital'];
    const line = (label, value) => `<tr><td class="muted" style="width:42%">${label}</td><td class="num"><b>${value}</b></td></tr>`;
    return `<html><head><meta charset="utf-8">${BASE}</head><body>
  <div class="band">${ARCS}
    <div class="top">${LOGO}<div class="doc"><b>Duty receipt</b>#${esc(String(data.dutyId).slice(-8).toUpperCase())}</div></div>
    <h1 class="num">${rs(data.totalEarning)}</h1><div class="sub">${esc(role(data.summary?.role))} at ${esc(data.hospital)} · ${date(data.summary?.date)}</div>
  </div>
  <div class="wrap">
    <div class="who">
      <div><div class="lab">Doctor</div><div class="val">${esc(s.name)}</div><div class="muted">${esc(s.email)}</div></div>
      <div><div class="lab">Hospital</div><div class="val">${esc(data.hospital)}</div></div>
    </div>
    <table>
      ${line('Shift', `${time(data.time?.startTime)} to ${time(data.time?.endTime)}`)}
      ${line('Hours', esc(data.time?.duration))}
      ${data.rate ? line('Rate', rs(data.rate) + ' per hour') : ''}
      ${line('Amount', rs(data.totalEarning))}
      ${line('Payment method', esc(METHOD[data.payment?.method] || 'Not recorded'))}
      <tr><td class="muted">Payment status</td><td><span class="pill ${st[1]}">${st[0]}</span>${data.payment?.attestedAt ? ` <span class="muted">on ${date(data.payment.attestedAt)}</span>` : ''}</td></tr>
    </table>
    <div class="note"><span>Hospitals pay doctors directly. This receipt records the duty and what the hospital reported.</span><span>Generated ${date(new Date())} · HospiLink</span></div>
  </div></body></html>`;
}

module.exports = { earningsTemplate, receiptTemplate };
