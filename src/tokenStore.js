const fs = require('fs');
const path = require('path');

const TOKENS_PATH = path.join(__dirname, '..', 'tokens.json');

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
}

module.exports = { saveTokens, loadTokens };
