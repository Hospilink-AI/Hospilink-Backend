// Turns business events (duty, account, job, support) into notifications:
// in-app, socket and push, through notificationService and its delivery.
class NotificationEmitter {}

// The methods live in ./notifications/, one file per area
Object.assign(NotificationEmitter.prototype,
    require('./notifications/duties'),
    require('./notifications/accounts'),
    require('./notifications/jobs'),
    require('./notifications/support')
);

module.exports = new NotificationEmitter();
