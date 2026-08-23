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

const util = require('util');

const setTimeoutPromise = util.promisify(setTimeout);

// Must exactly match .homeycompose/capabilities/{measure_range,measure_odo,
// meter_distance}.json's "km" block, so reverting to a km-reporting vehicle
// restores the original compose-time text.
const KM_UNITS = {
  en: 'km', nl: 'km', de: 'km', fr: 'km', es: 'km', it: 'km', da: 'km', sv: 'km', no: 'km', pl: 'km', ru: 'км', ar: 'كم', ko: 'km',
};
// "mi" for every locale — no verified per-locale miles abbreviation available.
const MI_UNITS = {
  en: 'mi', nl: 'mi', de: 'mi', fr: 'mi', es: 'mi', it: 'mi', da: 'mi', sv: 'mi', no: 'mi', pl: 'mi', ru: 'mi', ar: 'mi', ko: 'mi',
};

// AverageFuelEconomy.Unit -> display label. Unit 4 (km/kWh) is confirmed;
// units 1 (L/100km) and 5 (kWh/100km) are unconfirmed guesses and only get
// relabeled, not numerically converted, until verified against real data.
const KM_PER_KWH_UNITS = {
  en: 'km/kWh', nl: 'km/kWh', de: 'km/kWh', fr: 'km/kWh', es: 'km/kWh', it: 'km/kWh', da: 'km/kWh', sv: 'km/kWh', no: 'km/kWh', pl: 'km/kWh', ru: 'км/кВтч', ar: 'كم/ك.و.س', ko: 'km/kWh',
};
const MI_PER_KWH_UNITS = {
  en: 'mi/kWh', nl: 'mi/kWh', de: 'mi/kWh', fr: 'mi/kWh', es: 'mi/kWh', it: 'mi/kWh', da: 'mi/kWh', sv: 'mi/kWh', no: 'mi/kWh', pl: 'mi/kWh', ru: 'mi/kWh', ar: 'mi/kWh', ko: 'mi/kWh',
};
const L_PER_100KM_UNITS = {
  en: 'L/100km', nl: 'L/100km', de: 'L/100km', fr: 'L/100km', es: 'L/100km', it: 'L/100km', da: 'L/100km', sv: 'L/100km', no: 'L/100km', pl: 'L/100km', ru: 'L/100km', ar: 'L/100km', ko: 'L/100km',
};
const KWH_PER_100KM_UNITS = {
  en: 'kWh/100km', nl: 'kWh/100km', de: 'kWh/100km', fr: 'kWh/100km', es: 'kWh/100km', it: 'kWh/100km', da: 'kWh/100km', sv: 'kWh/100km', no: 'kWh/100km', pl: 'kWh/100km', ru: 'kWh/100km', ar: 'kWh/100km', ko: 'kWh/100km',
};

module.exports = {
  // Repairs a device's capability list (existence + order) against
  // `correctCaps`, restoring each surviving capability's previous value.
  // Snapshots the capability list once and does a single removal pass +
  // single addition pass — re-deriving the mismatch from
  // device.getCapabilities() after every change doesn't reflect this same
  // function's own removeCapability()/addCapability() calls as they happen,
  // turning an O(n) migration into O(n^2) round trips.
  async migrateCapabilities(device, correctCaps) {
    device.log(`checking device migration for ${device.getName()}`);

    const caps = device.getCapabilities();
    const state = {};
    caps.forEach((cap) => { state[cap] = device.getCapabilityValue(cap); });

    const maxLen = Math.max(caps.length, correctCaps.length);
    let firstMismatch = -1;
    for (let index = 0; index < maxLen; index += 1) {
      if (caps[index] !== correctCaps[index]) {
        firstMismatch = index;
        break;
      }
    }
    if (firstMismatch === -1) return;

    device.setUnavailable(device.homey.__('migrating')).catch(() => null);

    // remove all caps from the first mismatch onward — also covers extra
    // trailing caps not present in correctCaps at all
    for (let i = firstMismatch; i < caps.length; i += 1) {
      if (device.hasCapability(caps[i])) {
        device.log(`removing capability ${caps[i]} for ${device.getName()}`);
        await device.removeCapability(caps[i]).catch((error) => device.log(error));
        await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
      }
    }

    for (let index = firstMismatch; index < correctCaps.length; index += 1) {
      const newCap = correctCaps[index];
      if (newCap === undefined) continue;
      if (!device.hasCapability(newCap)) {
        device.log(`adding capability ${newCap} for ${device.getName()}`);
        await device.addCapability(newCap).catch((error) => device.log(error));
      }
      if (state[newCap] !== undefined) {
        device.log(`${device.getName()} restoring value ${newCap} to ${state[newCap]}`);
        device.setCapability(newCap, state[newCap]);
      }
      await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
    }
  },

  // Keeps measure_range/measure_odo/meter_distance's displayed unit matched to
  // what the vehicle itself reports (`imperial`, from device.js#mapStatus()'s
  // per-field unit code) rather than a device setting or Homey's
  // i18n.getUnits() (unreliable — see homey-app-development skill section 9).
  // Merges onto the manifest-declared options rather than passing
  // {units, decimals} alone, so a per-capability title override isn't
  // silently dropped.
  async syncDistanceUnits(device, imperial) {
    if (typeof imperial !== 'boolean') return;
    const targetUnits = imperial ? MI_UNITS : KM_UNITS;
    const manifestOptions = device.driver.manifest.capabilitiesOptions || {};
    const caps = ['measure_range', 'measure_odo', 'meter_distance'];
    for (const cap of caps) {
      if (!device.hasCapability(cap)) continue;
      const current = device.getCapabilityOptions(cap);
      if (current?.units?.en === targetUnits.en) continue;
      device.log(`updating ${cap} units to ${targetUnits.en} for ${device.getName()}`);
      const baseOptions = manifestOptions[cap] || {};
      await device.setCapabilityOptions(cap, { ...baseOptions, units: targetUnits, decimals: 1 })
        .catch((error) => device.error(error));
    }
  },

  // Keeps meter_power.fuel_economy's displayed unit matched to its raw
  // AverageFuelEconomy.Unit code. An unrecognized/missing code is left
  // alone — the compose-time default ("km/kWh") stays in place.
  async syncFuelEconomyUnits(device, afeUnitCode, imperial) {
    const cap = 'meter_power.fuel_economy';
    if (!device.hasCapability(cap)) return;
    let targetUnits;
    if (afeUnitCode === 4) targetUnits = imperial ? MI_PER_KWH_UNITS : KM_PER_KWH_UNITS;
    else if (afeUnitCode === 1) targetUnits = L_PER_100KM_UNITS;
    else if (afeUnitCode === 5) targetUnits = KWH_PER_100KM_UNITS;
    else return;

    const current = device.getCapabilityOptions(cap);
    if (current?.units?.en === targetUnits.en) return;
    device.log(`updating ${cap} units to ${targetUnits.en} for ${device.getName()}`);
    const manifestOptions = device.driver.manifest.capabilitiesOptions || {};
    const baseOptions = manifestOptions[cap] || {};
    await device.setCapabilityOptions(cap, { ...baseOptions, units: targetUnits })
      .catch((error) => device.error(error));
  },
};
