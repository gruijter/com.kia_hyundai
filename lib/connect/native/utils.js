'use strict';

// Poort van utils.py. De meeste Python-helpers in dat bestand bestaan om losse
// velden in een Vehicle-dataclass te normaliseren (float/bool/pressure coercion).
// Homey's device.js#mapStatus() leest de raw CCS2/legacy JSON zelf en heeft die
// normalisatie niet nodig — alleen getChildValue (dot-pad lookup) is overgenomen.

function getChildValue(data, key) {
  let value = data;
  for (const part of key.split('.')) {
    if (value === null || value === undefined) return undefined;
    value = value[part] !== undefined ? value[part] : value[Number(part)];
  }
  return value;
}

// Poort van KiaUvoApiEU.py#_get_stamp. Python's `zip(self.CFB, raw_data)`
// stopt bij de KORTSTE van de twee (CFB is langer dan "<appId>:<timestamp>"),
// dus dit is een niet-cyclische XOR van de eerste N bytes — geen modulo/wrap.
function xorStamp(cfbBuffer, appId) {
  const raw = Buffer.from(`${appId}:${Math.floor(Date.now() / 1000)}`, 'utf8');
  const len = Math.min(cfbBuffer.length, raw.length);
  const result = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) result[i] = cfbBuffer[i] ^ raw[i];
  return result.toString('base64');
}

// Poort van utils.py#get_index_into_hex_temp (non-CCS2 climate tempCode, e.g. "10H").
function getIndexIntoHexTemp(value) {
  if (value === null || value === undefined) return null;
  return `${value.toString(16)}H`.padStart(3, '0').toUpperCase();
}

module.exports = {
  getChildValue,
  xorStamp,
  getIndexIntoHexTemp,
};
