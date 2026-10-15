/*
Copyright 2020 - 2026, RM de Gruijter (rmdegruijter@gmail.com)

This file is part of com.kia_hyundai

com.kia_hyundai is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.kia_hyundai is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.kia_hyundai. If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

// Port of cci_fingerprint.py — X-Fingerprint signing for the EU CCI auth endpoints.
// The EU OneApp app signs POSTs to cci-api-eu.../auth/* with X-Fingerprint:
// HMAC-SHA256 over the client identity plus app-embedded secret constant
// pairs. The X-Timestamp is in the message only. Constants recovered from the
// app's Android 1.4.0 build (upstream, verified live 2026-10-14 for Hyundai
// and Kia EU; a wrong signature answers 9036, a missing X-Fingerprint 9035).

const crypto = require('crypto');
const { BRAND_HYUNDAI, BRAND_KIA } = require('./const');

// Signing constants per brand: [secret, piece, suffix], concatenated into
// the HMAC key in this order. The pieces rotate with app releases.
const FINGERPRINT_KEYS = {
  [BRAND_HYUNDAI]: ['OsZDfDuCyVX', 'yfqjCoA2JbX', '2MrLpGwNBC'],
  [BRAND_KIA]: ['yb4Z1n2nlKe', 'ukNilE7QEdb', 'KB34nStPVa'],
};

// Android OneApp build identity the gate validates the fingerprint against.
const CLIENT_VERSION = '1.4.0';
const CLIENT_OS_CODE = 'android';
const CLIENT_OS_VERSION = '14';
const CLIENT_DEVICE_MODEL = 'SM-S918B';
const CLIENT_NOTIFICATION_PROVIDER = 'FCM';
const USER_AGENT = 'okhttp/4.12.0';
const APP_REGION = 'eu';

const IDENTITY_HEADERS = ['client-id', 'client-name', 'client-version', 'client-os-code'];

// Key: identity (client-id + client-name + client-version + client-os-code)
//      + secret + piece + suffix.
// Message: identity + client-os-version + X-Timestamp
//      (+ request body with Java-ASCII whitespace removed).
function computeXFingerprint(headers, brand, body = '') {
  const lower = {};
  Object.entries(headers).forEach(([k, v]) => {
    lower[k.toLowerCase()] = v;
  });
  const identity = IDENTITY_HEADERS.map((name) => lower[name] || '').join('');
  const pieces = FINGERPRINT_KEYS[brand];
  const msg = identity
    + (lower['client-os-version'] || '')
    + (lower['x-timestamp'] || '')
    + (body || '').replace(/[ \t\n\v\f\r]+/g, '');
  const key = identity + pieces.join('');
  return crypto.createHmac('sha256', key).update(msg).digest('hex');
}

// Fingerprint-gate rejection family: 9035 = header missing, 9036 = bad
// signature, 9037 = timestamp out of window. The legacy fallback runs only
// on these, so a server-side 5xx or a business error on the signed path
// raises instead of being masked by a legacy 200.
const GATE_REJECTION_CODES = new Set([9035, 9036, 9037]);

function isGateRejection(statusCode, body) {
  if (!(statusCode >= 400 && statusCode < 500)) return false;
  try {
    return GATE_REJECTION_CODES.has(JSON.parse(body).code);
  } catch {
    return false;
  }
}

// 'HyundaiEU' / 'KiaEU' per the OneApp client-name scheme.
function clientNameForBrand(brand) {
  return `${brand}EU`;
}

// Header set for the fingerprint-gated CCI endpoints.
function buildFpHeaders({
  packageId, clientName, deviceId, locale, timezone, brandLabel,
}) {
  const requestId = crypto.randomUUID().replace(/-/g, '').slice(0, 24).toUpperCase();
  return {
    'client-id': packageId,
    'client-name': clientName,
    'client-version': CLIENT_VERSION,
    'client-os-code': CLIENT_OS_CODE,
    'client-os-version': CLIENT_OS_VERSION,
    'client-device-id': deviceId || '',
    'client-device-model': CLIENT_DEVICE_MODEL,
    'client-notification-provider-type': CLIENT_NOTIFICATION_PROVIDER,
    locale: locale.toUpperCase(),
    timezone,
    'App-Request-Id': `${requestId}_${(deviceId || '').replace(/-/g, '')}_AOS`,
    'X-Brand': brandLabel,
    'X-Region': APP_REGION,
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    'Accept-Language': locale.toLowerCase(),
  };
}

module.exports = {
  computeXFingerprint,
  isGateRejection,
  clientNameForBrand,
  buildFpHeaders,
};
