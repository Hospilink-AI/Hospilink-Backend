// A real MongoDB (the same major version as Atlas) for tests that need the
// database's own behaviour: query and projection rules, index builds,
// validation on save, atomic updates. Stubbed models can't catch those.
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let server;

// A loaded machine can be slow to start mongod: allow a minute, and retry once
async function start() {
    const options = { instance: { launchTimeout: 60000 } };
    try {
        server = await MongoMemoryServer.create(options);
    } catch (error) {
        server = await MongoMemoryServer.create(options);
    }
    await mongoose.connect(server.getUri(), { dbName: 'hospilink_test', autoIndex: false });
}

async function stop() {
    await mongoose.disconnect();
    if (server) await server.stop();
}

async function clear() {
    for (const collection of Object.values(mongoose.connection.collections)) {
        await collection.deleteMany({});
    }
}

// Insert without Mongoose hooks or validation, like data written by older code
function raw(Model, doc) {
    return Model.collection.insertOne(doc);
}

module.exports = { start, stop, clear, raw };
