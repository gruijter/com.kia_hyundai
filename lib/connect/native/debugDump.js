'use strict';

// Geen upstream-equivalent. Bouwt een zelfstandig, geredigeerd JSON-document
// van de laatst bekende auto-status, bedoeld om via een Homey maintenance
// action (zie drivers/car/device.js#onMaintenanceAction) gelogd te worden.
// Komt zo terecht in een door de gebruiker verstuurd diagnostics report en
// kan van daaruit handmatig overgezet worden naar zzz_responses/db/ — zie
// zzz_responses/db/README.md voor het bestandsformaat.

const { redact } = require('./logger');

// VIN: bewaar WMI+VDS+bouwjaar+fabriekscode (posities 1-11 — identificeert
// merk/model/jaar, nuttig om te herkennen), maskeer het productieserienummer
// (12-17, de daadwerkelijke unieke identifier van de auto).
function redactVin(vin) {
  if (typeof vin !== 'string') return vin;
  if (vin.length < 17) return '[redacted]';
  return `${vin.slice(0, 11)}******`;
}

// Rond coördinaten af op ~11 km i.p.v. het exacte adres van de gebruiker
// (nog steeds bruikbaar om een regio te herkennen bij locatie-gerelateerde bugs).
function redactCoordinate(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return value;
  return Math.round(value * 10) / 10;
}

const VIN_KEY_PATTERN = /^vin$/i;
const COORD_KEY_PATTERN = /^(lat|latitude|lon|lng|longitude)$/i;

// Loopt (net als redact() in ./logger) recursief door een API-response en
// maskeert VIN/GPS-velden, ongeacht op welke diepte of in welk schema
// (CCS2 vs. legacy) ze voorkomen — de veldnamen verschillen per regio/protocol.
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
    // account-scoped cloud-id, niet interessant voor debugging maar wel
    // herleidbaar naar het account — alleen een fragment bewaren.
    id: vehicleConfig.id ? `${String(vehicleConfig.id).slice(0, 8)}...` : vehicleConfig.id,
    vin: redactVin(vehicleConfig.vin),
    nickname: vehicleConfig.nickname ? '[redacted]' : vehicleConfig.nickname,
  };
}

// meta.engine/region/generation/ccuCCS2ProtocolSupport komen uit device
// settings (gezet tijdens pairing, zie driver.js#list_devices) omdat
// vehicleConfig zelf geen door de gebruiker onafhankelijk 'engine'-type kent.
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
