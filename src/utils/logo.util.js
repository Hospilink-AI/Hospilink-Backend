const fs = require('fs');
const path = require('path');

function getLogoBase64() {
    const logoPath = path.join(__dirname, '../assets/logo.png');
    const image = fs.readFileSync(logoPath);
    return `data:image/png;base64,${image.toString('base64')}`;
}

module.exports = { getLogoBase64 };