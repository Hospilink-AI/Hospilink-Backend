// One stray rejected promise doesn't take a server task down; a real crash
// stops gracefully and is logged with its stack
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const handler = (event) => {
    const start = server.indexOf(`process.on('${event}'`);
    return server.slice(start, server.indexOf('\n});', start));
};

test('an unhandled rejection is logged with its stack and the server keeps running', () => {
    const body = handler('unhandledRejection');
    expect(body).toContain('reason.stack');
    expect(body).not.toContain('process.exit');
});

test('an uncaught exception shuts down gracefully with a failure exit code', () => {
    const body = handler('uncaughtException');
    expect(body).toContain('error.stack');
    expect(body).toContain("shutdown('uncaughtException', running, 1)");
    expect(server).toContain('function shutdown(signal, { server, io }, exitCode = 0)');
    expect(server).toContain('process.exit(exitCode);');
});

test('signals and crashes share one shutdown', () => {
    expect(server).toContain('running = started;');
    expect(server.match(/let stopping = false;/g)).toHaveLength(1);
});
