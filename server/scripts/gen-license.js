#!/usr/bin/env node
// Issue a machine-locked YourHires license key. VENDOR-ONLY tool — it needs the
// private signing key (server/license-signing-key.pem), which must never ship
// with the app.
//
// The customer reads their machine fingerprint from the app
// (Settings → License, or the activation screen) and gives it to you. You run:
//
//   node scripts/gen-license.js --fp <FINGERPRINT> [--days 365] [--plan pro] [--licensee "Acme Ltd"]
//
//   --fp        (required) the customer's machine fingerprint, exactly as shown
//   --days      validity in days from now (omit or 0 = perpetual, never expires)
//   --plan      optional plan/tier label shown in the app
//   --licensee  optional name shown in the app
//
// Output is the license key string — send it to the customer to paste into the app.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const fp = arg('fp');
if (!fp) {
  console.error('ERROR: --fp <fingerprint> is required.\n');
  console.error('Usage: node scripts/gen-license.js --fp <FINGERPRINT> [--days 365] [--plan pro] [--licensee "Acme Ltd"]');
  process.exit(1);
}
const days = parseInt(arg('days', '0')) || 0;
const plan = arg('plan', '');
const licensee = arg('licensee', '');

const keyPath = path.join(__dirname, '..', 'license-signing-key.pem');
if (!fs.existsSync(keyPath)) {
  console.error(`ERROR: signing key not found at ${keyPath}`);
  console.error('This is the vendor private key — keep it secret and out of the app bundle.');
  process.exit(1);
}
const privateKey = fs.readFileSync(keyPath, 'utf-8');

const now = new Date();
const exp = days > 0 ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString() : '';
const payload = { fp: fp.trim(), exp, plan, licensee, iat: now.toISOString() };

const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf-8');
const sig = crypto.sign(null, payloadBuf, privateKey);

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = `${b64url(payloadBuf)}.${b64url(sig)}`;

console.log('\n=== YourHires License Key ===');
console.log(`Machine:   ${payload.fp}`);
console.log(`Expires:   ${exp || 'never (perpetual)'}`);
if (plan) console.log(`Plan:      ${plan}`);
if (licensee) console.log(`Licensee:  ${licensee}`);
console.log('\nKey (send this to the customer):\n');
console.log(token);
console.log('');
