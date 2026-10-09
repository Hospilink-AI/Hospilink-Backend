
class DutyService {

}

// The methods live in ./duty/, one file per area
Object.assign(DutyService.prototype,
    require('./duty/lifecycle'),
    require('./duty/staffViews'),
    require('./duty/hospitalViews'),
    require('./duty/detail'),
    require('./duty/scheduledJobs'),
    require('./duty/earnings'),
    require('./duty/handshake')
);

module.exports = new DutyService();
