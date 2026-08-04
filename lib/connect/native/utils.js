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
