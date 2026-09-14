const crypto = require('crypto');

function base64url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateVerifier() {
  return base64url(crypto.randomBytes(32));
}

function challengeFromVerifier(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function generateState() {
  return base64url(crypto.randomBytes(16));
}

module.exports = { generateVerifier, challengeFromVerifier, generateState };
