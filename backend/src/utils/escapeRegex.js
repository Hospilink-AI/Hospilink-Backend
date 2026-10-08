// Text from a request, made safe to put in a regular expression: every
// special character matches itself. Without this a crafted pattern such as
// (a+)+$ can make the database backtrack for minutes.
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = escapeRegex;
