'use strict';

// Port of utils.py. Most Python helpers in that file exist to normalize
// individual fields on a Vehicle dataclass (float/bool/pressure coercion).
// Homey's device.js#mapStatus() reads the raw CCS2/legacy JSON itself and
// doesn't need that normalization — only getChildValue (dot-path lookup)
// was carried over.

function getChildValue(data, key) {
  let value = data;
  for (const part of key.split('.')) {
    if (value === null || value === undefined) return undefined;
    value = value[part] !== undefined ? value[part] : value[Number(part)];
  }
  return value;
}

// Port of KiaUvoApiEU.py#_get_stamp. Python's `zip(self.CFB, raw_data)`
// stops at the SHORTER of the two (CFB is longer than "<appId>:<timestamp>"),
// so this is a non-cyclic XOR of the first N bytes — no modulo/wrap.
function xorStamp(cfbBuffer, appId) {
  const raw = Buffer.from(`${appId}:${Math.floor(Date.now() / 1000)}`, 'utf8');
  const len = Math.min(cfbBuffer.length, raw.length);
  const result = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) result[i] = cfbBuffer[i] ^ raw[i];
  return result.toString('base64');
}

// Port of utils.py#get_index_into_hex_temp (non-CCS2 climate tempCode, e.g. "10H").
function getIndexIntoHexTemp(value) {
  if (value === null || value === undefined) return null;
  return `${value.toString(16)}H`.padStart(3, '0').toUpperCase();
}

module.exports = {
  getChildValue,
  xorStamp,
  getIndexIntoHexTemp,
};
