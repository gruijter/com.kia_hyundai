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

// Deliberate local deviation from upstream (see NAMING.md): upstream's
// start_climate() looks up options.set_temp in self.temperature_range via
// Python's list.index(), which (like Array.prototype.indexOf(), used here
// until this was added) requires an exact float match. A set_temp that
// didn't originate as one of the range's own 0.5°C steps - e.g. a Celsius
// figure back-converted from a Fahrenheit UI input, which essentially never
// lands on an exact 0.5°C boundary - fails that exact match. Upstream's
// list.index() then raises ValueError (loudly wrong); indexOf() instead
// silently returns -1, which getIndexIntoHexTemp(-1) turns into the literal
// garbage string "-1H" sent straight to the car as the tempCode (silently
// wrong - confirmed by reading getIndexIntoHexTemp's implementation, no
// live car needed). This finds the range's closest entry instead, so a
// command is always built from one of the range's own valid values.
function nearestRangeIndex(range, value) {
  if (typeof value !== 'number' || Number.isNaN(value) || !range.length) return null;
  let closestIndex = 0;
  let closestDiff = Math.abs(range[0] - value);
  for (let i = 1; i < range.length; i += 1) {
    const diff = Math.abs(range[i] - value);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIndex = i;
    }
  }
  return closestIndex;
}

// JS-side helper for a pattern repeated inline throughout
// ApiImplType1.py#schedule_charging_and_climate/_schedule_ev5_flat:
// dt.time.strftime("%I%M") (12-hour, zero-padded) plus a timeSection flag
// (0 = AM, 1 = PM/>=12:00). JS has no dt.time equivalent, so this takes a
// 24-hour "HH:MM" string instead.
function formatScheduleTime(hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const timeSection = hours >= 12 ? 1 : 0;
  const hours12 = (hours % 12) || 12;
  return {
    time: `${String(hours12).padStart(2, '0')}${String(minutes).padStart(2, '0')}`,
    timeSection,
  };
}

// Port of utils.py#ccs2_reservation_time_or_none — parses a CCS2
// Green.Reservation time field (OffPeakTime / Departure.Schedule{1,2}).
// The API uses the out-of-range value 31:70 (hour 31, minute 70) as the
// "unconfigured" default on ccNC EVs (#1269) — that must resolve to null,
// not a bogus time. hour/minute null (stub block, e.g. EV9
// Schedule={"Enable": false}) also -> null. Returns { hours, minutes }
// (JS has no dt.time) or null.
function ccs2ReservationTimeOrNone(hour, minute) {
  if (hour === null || hour === undefined || minute === null || minute === undefined) return null;
  const hours = Number(hour);
  const minutes = Number(minute);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59 || hours < 0 || minutes < 0) return null; // sentinel 31:70
  return { hours, minutes };
}

// Port of ApiImplType1.py#_get_time_from_string — parses a legacy
// reservChargeInfos time ({ time: "HHMM" 12-hour, timeSection: 0=AM/1=PM }).
// "0000"/"0"/"" = unset EV timer (#1206). The `lastTwo > 60` branch and the
// `> 1260` 24-hour fallback mirror upstream's handling of malformed values
// (e.g. the "1270" sentinel seen on some PHEVs). Returns { hours, minutes }
// or null.
function legacyReservationTimeOrNone(value, timeSection) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str || Number(str) === 0) return null;
  let n = Number(str);
  if (!Number.isFinite(n)) return null;
  if (Number(str.slice(-2)) > 60) n += 40;
  let hours;
  let minutes;
  if (n > 1260) {
    hours = Math.floor(n / 100);
    minutes = n % 100;
  } else {
    // Python strptime("%I%M") + a +12h shift when timeSection > 0.
    minutes = n % 100;
    hours = (Math.floor(n / 100) + (timeSection && timeSection > 0 ? 12 : 0)) % 24;
  }
  if (hours > 23 || minutes > 59 || hours < 0 || minutes < 0) return null;
  return { hours, minutes };
}

module.exports = {
  getChildValue,
  xorStamp,
  getIndexIntoHexTemp,
  nearestRangeIndex,
  formatScheduleTime,
  ccs2ReservationTimeOrNone,
  legacyReservationTimeOrNone,
};
