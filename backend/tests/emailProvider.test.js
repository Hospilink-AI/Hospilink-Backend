jest.mock('../src/utils/logger', () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }));
const mockSmtp = [];
jest.mock('nodemailer', () => ({
    createTransport: () => ({
        verify: () => {},
        sendMail: async (options) => { mockSmtp.push(options.to); return { messageId: 'smtp-1' }; }
    })
}));
const mockSes = [];
let mockSesFails = false;
jest.mock('@aws-sdk/client-sesv2', () => ({
    SESv2Client: class { async send(command) { if (mockSesFails) throw new Error('ses down'); mockSes.push(command.input); return { MessageId: 'ses-1' }; } },
    SendEmailCommand: class { constructor(input) { this.input = input; } }
}));

const ENV_KEYS = ['EMAIL_PROVIDER', 'EMAIL_HOST', 'RESEND_API_KEY', 'AWS_REGION', 'AWS_SES_REGION', 'EMAIL_FROM'];
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

function load(env) {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, { EMAIL_FROM: 'no-reply@hospilink.in' }, env);
    let service;
    jest.isolateModules(() => { service = require('../src/services/email.service'); });
    return service;
}

beforeEach(() => {
    mockSmtp.length = 0;
    mockSes.length = 0;
    mockSesFails = false;
    global.fetch = jest.fn();
});
afterAll(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe('email providers', () => {
    it('uses SMTP by default, as before', async () => {
        const email = load({ EMAIL_HOST: 'smtp.example.com' });
        expect(await email.sendAdminOTPEmail('admin@x.com', '123456', 'Asha')).not.toBe(false);
        expect(mockSmtp).toEqual(['admin@x.com']);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('sends through the SES API', async () => {
        const email = load({ EMAIL_PROVIDER: 'ses', AWS_REGION: 'ap-south-1' });
        await email.sendAdminOTPEmail('admin@x.com', '123456', 'Asha');
        expect(mockSes).toHaveLength(1);
        expect(mockSes[0]).toMatchObject({
            FromEmailAddress: 'HospiLink Admin <no-reply@hospilink.in>',
            Destination: { ToAddresses: ['admin@x.com'] }
        });
        expect(mockSes[0].Content.Simple.Body.Html.Data).toContain('123456');
        expect(mockSmtp).toEqual([]);
    });

    it('sends through the Resend API', async () => {
        global.fetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'r1' }) });
        const email = load({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test' });
        await email.sendOTPEmail('doc@x.com', '654321', 'Ravi');
        const [url, request] = global.fetch.mock.calls[0];
        expect(url).toBe('https://api.resend.com/emails');
        expect(request.headers.Authorization).toBe('Bearer re_test');
        expect(JSON.parse(request.body)).toMatchObject({ to: ['doc@x.com'], subject: expect.any(String) });
        expect(mockSmtp).toEqual([]);
    });

    it('falls back to SMTP when the API fails and SMTP is set up', async () => {
        mockSesFails = true;
        const email = load({ EMAIL_PROVIDER: 'ses', AWS_REGION: 'ap-south-1', EMAIL_HOST: 'smtp.example.com' });
        await email.sendAdminOTPEmail('admin@x.com', '123456', 'Asha');
        expect(mockSmtp).toEqual(['admin@x.com']);
    });

    it('reports the failure when there is no SMTP to fall back to', async () => {
        global.fetch.mockResolvedValue({ ok: false, status: 422, text: async () => 'domain not verified' });
        const email = load({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test' });
        await expect(email._sendWithTimeout({ from: 'a@x.com', to: 'b@x.com', subject: 's', html: 'h' }))
            .rejects.toThrow('Resend 422: domain not verified');
        expect(mockSmtp).toEqual([]);
    });
});
