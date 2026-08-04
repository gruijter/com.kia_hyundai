'use strict';

// Geen upstream-equivalent (Python gebruikt de standaard `logging`-module).
// Nodig omdat Homey's crash-/diagnostic-reports vaak het enige zijn waarop
// niet-EU-regio's te debuggen zijn (geen testaccounts beschikbaar) — zie
// ../NAMING.md. device.js/driver.js geven hun `this.log`/`this.error` door
// via createClient({ logger }), zodat HTTP- en login-logging in Homey's
// eigen logviewer en diagnostic reports terechtkomt.

// Namen (case-insensitive) waarvan de WAARDE nooit gelogd mag worden — in
// headers, request- of response-bodies. Voorkomt dat wachtwoorden, PINs,
// tokens, cookies of OTP-codes in Homey-logs/diagnostic reports belanden.
const SENSITIVE_KEY_PATTERN = /pass|pin\b|otp|token|secret|author|cookie|^sid$|rmtoken/i;

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

// Redigeert een JSON-achtige string (response/request body) door 'm te
// parsen, te redacten, en weer te stringifyen. Valt terug op een afgekapte
// ruwe string als het geen geldige JSON is (bv. een HTML-foutpagina).
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

// Geeft een logger terug die elke regel prefixt met bv. "[KiaUvoApiEU]",
// zodat meerdere gelijktijdige devices/regio's in Homey's gedeelde logstream
// uit elkaar te houden zijn.
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
