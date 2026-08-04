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

// No upstream equivalent (Python uses the standard `logging` module).
// Needed because Homey crash/diagnostic reports are often the only way to
// debug non-EU regions (no test accounts available) — see ../NAMING.md.
// device.js/driver.js pass their `this.log`/`this.error` through via
// createClient({ logger }), so HTTP and login logging ends up in Homey's
// own log viewer and diagnostic reports.

// Names (case-insensitive) whose VALUE must never be logged — in headers,
// request or response bodies. Prevents passwords, PINs, tokens, cookies, or
// OTP codes from ending up in Homey logs/diagnostic reports.
// 'passw' instead of 'pass': otherwise this also matches real, harmless
// CCS2 status fields like Door/Window/Seat.Row1.Passenger (found during a
// live test — that field was incorrectly redacted because of this).
const SENSITIVE_KEY_PATTERN = /passw|pin\b|otp|token|secret|author|cookie|^sid$|rmtoken/i;

function redact(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  const out = {};
  Object.entries(value).forEach(([key, val]) => {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redact(val, seen);
  });
  return out;
}

// Redacts a JSON-like string (response/request body) by parsing it,
// redacting it, and stringifying it again. Falls back to a truncated raw
// string if it isn't valid JSON (e.g. an HTML error page).
function redactBodyString(text, maxLength = 500) {
  if (!text) return text;
  try {
    return JSON.stringify(redact(JSON.parse(text))).slice(0, maxLength);
  } catch (error) {
    return text.slice(0, maxLength);
  }
}

const noopLogger = { log() {}, error() {} };

function normalizeLogger(logger) {
  if (!logger) return noopLogger;
  return {
    log: typeof logger.log === 'function' ? (...args) => logger.log(...args) : () => {},
    error: typeof logger.error === 'function' ? (...args) => logger.error(...args) : () => {},
  };
}

// Returns a logger that prefixes every line with e.g. "[KiaUvoApiEU]", so
// multiple concurrent devices/regions can be told apart in Homey's shared
// log stream.
function prefixLogger(logger, prefix) {
  const base = normalizeLogger(logger);
  return {
    log: (...args) => base.log(`[${prefix}]`, ...args),
    error: (...args) => base.error(`[${prefix}]`, ...args),
  };
}

module.exports = {
  redact, redactBodyString, normalizeLogger, prefixLogger,
};
