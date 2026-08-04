'use strict';

// No upstream equivalent. Builds a self-contained, redacted JSON document
// of the last known vehicle status, logged on every app/device restart (see
// drivers/car/device.js#doPoll). Ends up in a diagnostics report sent by the
// user, and can be copied from there into zzz_responses/db/ — see
// zzz_responses/README.md for the file format.

const { redact } = require('./logger');

// VIN: keep WMI+VDS+model year+plant code (positions 1-11 — identifies
// brand/model/year, useful for recognition), mask the production serial
// number (12-17, the vehicle's actual unique identifier).
function redactVin(vin) {
  if (typeof vin !== 'string') return vin;
  if (vin.length < 17) return '[redacted]';
  return `${vin.slice(0, 11)}******`;
}

// Round coordinates to ~11km instead of the user's exact address (still
// useful for recognizing a region when debugging location-related bugs).
function redactCoordinate(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return value;
  return Math.round(value * 10) / 10;
}

const VIN_KEY_PATTERN = /^vin$/i;
const COORD_KEY_PATTERN = /^(lat|latitude|lon|lng|longitude)$/i;

// Recursively walks an API response (like redact() in ./logger) and masks
// VIN/GPS fields, regardless of depth or schema (CCS2 vs. legacy) — the
// field names differ per region/protocol.
function redactPII(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactPII(v, seen));
  const out = {};
  Object.entries(value).forEach(([key, val]) => {
    if (VIN_KEY_PATTERN.test(key)) out[key] = redactVin(val);
    else if (COORD_KEY_PATTERN.test(key)) out[key] = redactCoordinate(val);
    else out[key] = redactPII(val, seen);
  });
  return out;
}

function redactVehicleConfig(vehicleConfig) {
  if (!vehicleConfig || typeof vehicleConfig !== 'object') return vehicleConfig;
  return {
    ...vehicleConfig,
    // account-scoped cloud id, not useful for debugging but traceable back
    // to the account — keep only a fragment.
    id: vehicleConfig.id ? `${String(vehicleConfig.id).slice(0, 8)}...` : vehicleConfig.id,
    vin: redactVin(vehicleConfig.vin),
    nickname: vehicleConfig.nickname ? '[redacted]' : vehicleConfig.nickname,
  };
}

// meta.engine/region/generation/ccuCCS2ProtocolSupport come from device
// settings (set during pairing, see driver.js#list_devices) because
// vehicleConfig itself has no 'engine' type independent of that.
function buildVehicleDebugDump({
  brand, region, engine, generation, ccuCCS2ProtocolSupport, vehicleConfig, status, odometer,
}) {
  return {
    meta: {
      brand,
      region,
      generation,
      engine,
      ccuCCS2ProtocolSupport: !!ccuCCS2ProtocolSupport,
      collectedAt: new Date().toISOString(),
    },
    vehicleConfig: redact(redactVehicleConfig(vehicleConfig)),
    status: redactPII(redact(status)),
    odometer: redactPII(redact(odometer)),
  };
}

module.exports = {
  redactVin, redactCoordinate, redactPII, buildVehicleDebugDump,
};
