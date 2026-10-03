const mongoose = require('mongoose');
const systemConfigService = require('../systemConfig.service');
const { round, ratio } = require('../../utils/analytics.helper');

// Where platform revenue comes from. Today the platform takes no fee, so
// 'projected' estimates commission from completed GMV at the configured
// percentage. Once payments are integrated (e.g. Razorpay), a
// PaymentTransaction collection is expected with:
//   type: 'charge' | 'refund' | 'payout' | 'subscription' | 'fee'
//   amount, platformFee, gst, status, gatewayRef,
//   duty, hospital, staff, plan, createdAt
// and setting analytics.revenueSource to 'ledger' switches to real figures.
class RevenueProvider {
    async getSettings() {
        const cfg = await systemConfigService.getManyEffective([
            'analytics.revenueSource',
            'analytics.projectedCommissionPercent'
        ]);
        return {
            source: cfg['analytics.revenueSource'],
            commissionPercent: cfg['analytics.projectedCommissionPercent']
        };
    }



    // Revenue for a period, given that period's completed GMV and duty count
    async getRevenue({ start, end, gmvCompleted, dutiesCompleted }) {
        const settings = await this.getSettings();

        if (settings.source === 'ledger') {
            const ledger = await this._fromLedger(start, end);
            if (ledger) return ledger;
        }

        const commission = gmvCompleted * (settings.commissionPercent || 0) / 100;
        return {
            source: 'projected',
            isProjected: true,
            commissionPercent: settings.commissionPercent,
            commission: round(commission),
            netRevenue: round(commission),
            takeRate: ratio(commission, gmvCompleted),
            revenuePerCompletedDuty: dutiesCompleted ? round(commission / dutiesCompleted) : null,
            refunds: null,
            subscriptions: null,
            payments: null
        };
    }



    // Real figures once a payments ledger exists; null until then
    async _fromLedger(start, end) {
        const PaymentTransaction = mongoose.models.PaymentTransaction;
        if (!PaymentTransaction) return null;

        const rows = await PaymentTransaction.aggregate([
            { $match: { createdAt: { $gte: start, $lt: end } } },
            {
                $group: {
                    _id: { type: '$type', status: '$status' },
                    amount: { $sum: '$amount' },
                    platformFee: { $sum: '$platformFee' },
                    count: { $sum: 1 }
                }
            }
        ]);

        const pick = (type, status) => rows.filter(r => r._id.type === type && (!status || r._id.status === status));
        const total = (list, field) => list.reduce((s, r) => s + (r[field] || 0), 0);

        const charges = pick('charge');
        const successfulCharges = pick('charge', 'success');
        const refunds = pick('refund', 'success');
        const subscriptions = pick('subscription', 'success');

        const commission = total(successfulCharges, 'platformFee');
        const refunded = total(refunds, 'amount');
        const gmvCharged = total(successfulCharges, 'amount');

        return {
            source: 'ledger',
            isProjected: false,
            commission: round(commission),
            netRevenue: round(commission + total(subscriptions, 'amount') - refunded),
            takeRate: ratio(commission, gmvCharged),
            refunds: { amount: round(refunded), count: total(refunds, 'count') },
            subscriptions: { revenue: round(total(subscriptions, 'amount')), payments: total(subscriptions, 'count') },
            payments: {
                attempts: total(charges, 'count'),
                successful: total(successfulCharges, 'count'),
                successRate: ratio(total(successfulCharges, 'count'), total(charges, 'count'))
            }
        };
    }
}

module.exports = new RevenueProvider();
