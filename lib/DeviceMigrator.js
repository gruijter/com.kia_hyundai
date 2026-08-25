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

// Must exactly match .homeycompose/capabilities/measure_speed.json's "km/h"
// block (driver.compose.json capabilitiesOptions.measure_speed), so
// reverting to a km/h-reporting vehicle restores the original compose-time
// text.
const KM_H_UNITS = {
  en: 'km/h', nl: 'km/u', de: 'km/h', fr: 'km/h', es: 'km/h', it: 'km/h', da: 'km/t', sv: 'km/h', no: 'km/t', pl: 'km/h', ru: 'км/ч', ar: 'كم/س', ko: 'km/h',
};
// "mph" for every locale — same reasoning as MI_UNITS above.
const MPH_UNITS = {
  en: 'mph', nl: 'mph', de: 'mph', fr: 'mph', es: 'mph', it: 'mph', da: 'mph', sv: 'mph', no: 'mph', pl: 'mph', ru: 'mph', ar: 'mph', ko: 'mph',
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
  //
  // Deliberately never reads back device.getCapabilityOptions() to decide
  // whether a write is needed — unlike a one-off boot check, this runs from
  // every doPoll() (every 15 min, for the device's whole lifetime), and that
  // live read can throw "Invalid Capability" right after a fresh app boot
  // even though hasCapability() just confirmed the cap exists (observed on a
  // device paired since 2020, not a migration-timing artifact). Tracking the
  // last-applied unit in the device's store instead (mirroring
  // com.gruijter.powerhour's DeviceMigrator, which also never depends on a
  // live get-before-set) sidesteps that read entirely, and — unlike an
  // in-memory flag — survives app restarts, so a restart where nothing
  // actually changed doesn't re-log/re-write on every single boot. The
  // manifest-declared options are always safely available as the merge base
  // regardless.
  async syncDistanceUnits(device, imperial) {
    if (typeof imperial !== 'boolean') return;
    const targetUnits = imperial ? MI_UNITS : KM_UNITS;
    if (device.getStoreValue('appliedDistanceUnits') === targetUnits.en) return;
    const manifestOptions = device.driver.manifest.capabilitiesOptions || {};
    const caps = ['measure_range', 'measure_odo', 'meter_distance'];
    let allApplied = true;
    for (const cap of caps) {
      if (!device.hasCapability(cap)) continue;
      device.log(`updating ${cap} units to ${targetUnits.en} for ${device.getName()}`);
      const baseOptions = manifestOptions[cap] || {};
      // eslint-disable-next-line no-await-in-loop
      const applied = await device.setCapabilityOptions(cap, { ...baseOptions, units: targetUnits, decimals: 1 })
        .then(() => true)
        .catch((error) => { device.error(error); return false; });
      if (!applied) allApplied = false;
    }
    if (allApplied) await device.setStoreValue('appliedDistanceUnits', targetUnits.en).catch((error) => device.error(error));
  },

  // Keeps measure_speed's displayed unit matched to the vehicle's own
  // per-field unit (same source/reasoning as syncDistanceUnits() above -
  // separate function because the unit text differs, km/h vs km, and it
  // tracks its own last-applied store value).
  async syncSpeedUnits(device, imperial) {
    const cap = 'measure_speed';
    if (typeof imperial !== 'boolean' || !device.hasCapability(cap)) return;
    const targetUnits = imperial ? MPH_UNITS : KM_H_UNITS;
    if (device.getStoreValue('appliedSpeedUnits') === targetUnits.en) return;
    device.log(`updating ${cap} units to ${targetUnits.en} for ${device.getName()}`);
    const manifestOptions = device.driver.manifest.capabilitiesOptions || {};
    const baseOptions = manifestOptions[cap] || {};
    await device.setCapabilityOptions(cap, { ...baseOptions, units: targetUnits })
      .then(() => device.setStoreValue('appliedSpeedUnits', targetUnits.en))
      .catch((error) => device.error(error));
  },

  // Keeps meter_power.fuel_economy's displayed unit matched to its raw
  // AverageFuelEconomy.Unit code. An unrecognized/missing code is left
  // alone — the compose-time default ("km/kWh") stays in place. See
  // syncDistanceUnits() above for why this also avoids a live
  // getCapabilityOptions() read before writing, and persists the
  // last-applied unit in the store rather than in memory.
  async syncFuelEconomyUnits(device, afeUnitCode, imperial) {
    const cap = 'meter_power.fuel_economy';
    if (!device.hasCapability(cap)) return;
    let targetUnits;
    if (afeUnitCode === 4) targetUnits = imperial ? MI_PER_KWH_UNITS : KM_PER_KWH_UNITS;
    else if (afeUnitCode === 1) targetUnits = L_PER_100KM_UNITS;
    else if (afeUnitCode === 5) targetUnits = KWH_PER_100KM_UNITS;
    else return;
    if (device.getStoreValue('appliedFuelEconomyUnits') === targetUnits.en) return;

    device.log(`updating ${cap} units to ${targetUnits.en} for ${device.getName()}`);
    const manifestOptions = device.driver.manifest.capabilitiesOptions || {};
    const baseOptions = manifestOptions[cap] || {};
    await device.setCapabilityOptions(cap, { ...baseOptions, units: targetUnits })
      .then(() => device.setStoreValue('appliedFuelEconomyUnits', targetUnits.en))
      .catch((error) => device.error(error));
  },
};
