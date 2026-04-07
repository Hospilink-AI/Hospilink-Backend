module.exports = (text) => ({
    hospitalName: text.match(/Hospital[:\s]+(.+)/i)?.[1]?.trim(),
    registrationNumber: text.match(/CGHS\s?[\w\d]+/i)?.[0],
    address: text.match(/Address[:\s]+(.+)/i)?.[1]?.trim()
});