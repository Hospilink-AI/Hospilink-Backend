// PUT /api/profile/me saves only the fields a doctor or hospital may edit.
// Before, the whole body was saved, so anyone could send
// { "verificationStatus": "verified" } and verify themselves.
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || 'test-key';

const mongoose = require('mongoose');
const User = require('../src/models/User');
const MedicalStaff = require('../src/models/MedicalStaff');
const Hospital = require('../src/models/Hospital');
const profileService = require('../src/services/profile.service');
const { editableProfileFields } = profileService;

const attack = {
    verificationStatus: 'verified',
    verifiedAt: new Date(),
    isSuspended: false,
    averageRating: 5,
    totalRatings: 999,
    isDemo: true,
    isAvailable: true,
    user: new mongoose.Types.ObjectId(),
    preferences: { maxDistanceKm: 1 }
};

test('a doctor can change their profile details and nothing else', () => {
    const picked = editableProfileFields('staff', { ...attack, fullName: 'Asha Rao', city: 'Pune', skills: ['ICU'] });
    expect(picked).toEqual({ fullName: 'Asha Rao', city: 'Pune', skills: ['ICU'] });
});

test('a hospital can change its details and nothing else', () => {
    const picked = editableProfileFields('hospital', { ...attack, hospitalLegalName: 'Sai Hospital', staffCount: '50-100' });
    expect(picked).toEqual({ hospitalLegalName: 'Sai Hospital', staffCount: '50-100' });
});

test('every field the apps send is still accepted', () => {
    const doctor = ['fullName', 'jobRole', 'experience', 'currentAddress', 'city', 'state', 'pincode', 'profileSummary', 'education', 'skills'];
    const hospital = ['hospitalLegalName', 'currentAddress', 'city', 'state', 'pincode', 'staffCount', 'servicesAvailable', 'description'];
    expect(profileService.EDITABLE_PROFILE_FIELDS.staff).toEqual(expect.arrayContaining(doctor));
    expect(profileService.EDITABLE_PROFILE_FIELDS.hospital).toEqual(expect.arrayContaining(hospital));
});

test('the update itself never writes a protected field', async () => {
    const userId = new mongoose.Types.ObjectId();
    const chain = (value) => { const c = { select: () => c, lean: async () => value }; return c; };
    User.findById = () => chain({ _id: userId, name: 'Asha Rao', email: 'a@test.in', role: 'staff' });
    MedicalStaff.findOne = () => chain({ user: userId, fullName: 'Asha Rao', city: 'Pune' });
    let written = null;
    MedicalStaff.findOneAndUpdate = async (filter, update) => { written = update; throw new Error('stop here'); };
    Hospital.findOneAndUpdate = async () => { throw new Error('not a hospital'); };

    await expect(profileService.updateUserProfile(userId, { ...attack, profileSummary: 'ICU nurse' })).rejects.toThrow();
    expect(written.profileSummary).toBe('ICU nurse');
    for (const field of Object.keys(attack)) expect(written).not.toHaveProperty(field);
});
