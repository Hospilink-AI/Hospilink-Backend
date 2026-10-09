// Clearing every stored opening is a Super Admin action, never a doctor's.
const { requireSuperAdmin } = require('../../agent/middleware/auth.middleware');

function run(user) {
    let status = 200;
    let passed = false;
    const res = { status: (s) => { status = s; return res; }, json: () => res };
    requireSuperAdmin({ user, path: '/v1/jobs/clear' }, res, () => { passed = true; });
    return { passed, status };
}

describe('agent admin-only routes', () => {
    it('lets a Super Admin through', () => {
        expect(run({ _id: 'a', role: 'admin', adminSubRole: 'super_admin' }).passed).toBe(true);
    });

    it.each([
        [{ _id: 's', role: 'staff' }],
        [{ _id: 'h', role: 'hospital' }],
        [{ _id: 'o', role: 'admin', adminSubRole: 'operations_manager' }],
        [undefined]
    ])('refuses %j', (user) => {
        expect(run(user)).toEqual({ passed: false, status: 403 });
    });

    it('guards DELETE /v1/jobs/clear with it', () => {
        const source = require('fs').readFileSync(require('path').join(__dirname, '../../agent/api.js'), 'utf8');
        expect(source).toContain('app.delete("/v1/jobs/clear", authenticateSuperAdmin,');
    });

    it('logs no doctor name or address on access', () => {
        const source = require('fs').readFileSync(require('path').join(__dirname, '../../agent/middleware/auth.middleware.js'), 'utf8');
        expect(source).not.toMatch(/name: medicalStaff\.fullName/);
        expect(source).not.toMatch(/medicalStaff\.currentAddress/);
    });
});
