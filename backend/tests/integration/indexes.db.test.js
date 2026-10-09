// Every index every model declares builds on a real MongoDB. Two Duty index
// definitions that MongoDB always rejected went unnoticed for months.
jest.setTimeout(180000);

const fs = require('fs');
const path = require('path');
const db = require('./db');

const modelsDir = path.join(__dirname, '../../src/models');
const models = fs.readdirSync(modelsDir)
    .filter(file => file.endsWith('.js'))
    .map(file => require(path.join(modelsDir, file)))
    .filter(model => model && model.modelName && typeof model.createIndexes === 'function');

beforeAll(db.start);
afterAll(db.stop);

test('there are models to check', () => {
    expect(models.length).toBeGreaterThan(15);
});

test.each(models.map(model => [model.modelName, model]))('%s indexes build', async (name, model) => {
    await model.createCollection().catch(() => {});
    await expect(model.createIndexes()).resolves.not.toThrow();
    const built = await model.collection.indexes();
    // Every declared index exists (plus _id)
    expect(built.length).toBeGreaterThanOrEqual(model.schema.indexes().length);
});

test('notifications expire after 90 days', async () => {
    const Notification = require('../../src/models/Notification');
    const indexes = await Notification.collection.indexes();
    const ttl = indexes.find(index => index.key.createdAt === 1 && Object.keys(index.key).length === 1);
    expect(ttl).toBeDefined();
    expect(ttl.expireAfterSeconds).toBe(90 * 24 * 60 * 60);
});

test('activity logs are kept forever: no index on them expires', async () => {
    const ActivityLog = require('../../src/models/ActivityLog');
    const indexes = await ActivityLog.collection.indexes();
    expect(indexes.find(index => index.key.timestamp === 1 && Object.keys(index.key).length === 1)).toBeDefined();
    expect(indexes.filter(index => index.expireAfterSeconds !== undefined)).toEqual([]);
});
