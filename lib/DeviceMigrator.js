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

// units.en for these must exactly match .homeycompose/capabilities/{measure_range,
// measure_odo,meter_distance}.json's "km" block, so switching back to a
// km-reporting vehicle restores the original compose-time text.
const KM_UNITS = {
  en: 'km', nl: 'km', de: 'km', fr: 'km', es: 'km', it: 'km', da: 'km', sv: 'km', no: 'km', pl: 'km', ru: 'км', ar: 'كم', ko: 'km',
};
// "mi" used for every locale — the international abbreviation, not translated per-language
// (no verified per-locale miles abbreviation available; see homey-app-development skill #1).
const MI_UNITS = {
  en: 'mi', nl: 'mi', de: 'mi', fr: 'mi', es: 'mi', it: 'mi', da: 'mi', sv: 'mi', no: 'mi', pl: 'mi', ru: 'mi', ar: 'mi', ko: 'mi',
};

// Drivetrain.FuelSystem.AverageFuelEconomy.Unit code -> display label for
// meter_power.fuel_economy. Same "one literal symbol for every locale" approach
// as KM_UNITS/MI_UNITS above (no per-language unit translation available/needed).
//
// Confidence, derived by cross-checking each code's raw value against DTE range
// ÷ battery kWh across zzz_responses/db/EU's CCS2 captures (2026-08-23):
//  - 4 = km/kWh (or mi/kWh under the same this.imperialDistance flag as
//    distance): REASONABLY CONFIRMED — 4 independent EV captures each land
//    within ~20-30% of an independently-computed range/battery figure, a
//    margin consistent with DTE not being purely linear off recent efficiency.
//  - 1 = L/100km: UNCONFIRMED — a single capture (kia-niro-hev-ice.json /
//    kona-hev-ice, Unit:1, value 5.3), plausible for a hybrid but not
//    cross-checked against anything (no DTE/battery basis for an ICE vehicle).
//  - 5 = kWh/100km: UNCONFIRMED — a single capture (kia-ev6...json, Unit:5,
//    value 18.6). Doesn't match km/kWh directly (raw value ~2.6x the computed
//    range/battery figure), but inverted+scaled (100/18.6=5.4) lands right
//    alongside the Unit:4 vehicles' own 5-7 km/kWh range.
// hyundai_kia_connect_api doesn't parse this field at all, so there is no
// external reference to check either code against — needs a second real
// capture (ideally from a different Unit:1/5 vehicle) before being treated as
// settled. Only unit 4 gets numeric conversion for imperial; 1 and 5 are only
// relabeled, not converted, to avoid compounding an unconfirmed guess with more
// unverified math.
const KM_PER_KWH_UNITS = {
  en: 'km/kWh', nl: 'km/kWh', de: 'km/kWh', fr: 'km/kWh', es: 'km/kWh', it: 'km/kWh', da: 'km/kWh', sv: 'km/kWh', no: 'km/kWh', pl: 'km/kWh', ru: 'км/кВтч', ar: 'كم/ك.و.س', ko: 'km/kWh',
};
const MI_PER_KWH_UNITS = {
  en: 'mi/kWh', nl: 'mi/kWh', de: 'mi/kWh', fr: 'mi/kWh', es: 'mi/kWh', it: 'mi/kWh', da: 'mi/kWh', sv: 'mi/kWh', no: 'mi/kWh', pl: 'mi/kWh', ru: 'mi/kWh', ar: 'mi/kWh', ko: 'mi/kWh',
};
// UNCONFIRMED (see comment above) — kept as a plain, non-locale-varying literal.
const L_PER_100KM_UNITS = {
  en: 'L/100km', nl: 'L/100km', de: 'L/100km', fr: 'L/100km', es: 'L/100km', it: 'L/100km', da: 'L/100km', sv: 'L/100km', no: 'L/100km', pl: 'L/100km', ru: 'L/100km', ar: 'L/100km', ko: 'L/100km',
};
// UNCONFIRMED (see comment above) — kept as a plain, non-locale-varying literal.
const KWH_PER_100KM_UNITS = {
  en: 'kWh/100km', nl: 'kWh/100km', de: 'kWh/100km', fr: 'kWh/100km', es: 'kWh/100km', it: 'kWh/100km', da: 'kWh/100km', sv: 'kWh/100km', no: 'kWh/100km', pl: 'kWh/100km', ru: 'kWh/100km', ar: 'kWh/100km', ko: 'kWh/100km',
};

module.exports = {
  // Repairs a device's capability list (existence + order) against
  // `correctCaps`, restoring each surviving capability's previous value.
  // Snapshots the capability list once and does a single removal pass +
  // single addition pass, rather than re-deriving the mismatch from
  // device.getCapabilities() after every change — that re-fetch doesn't
  // reflect this same function's own removeCapability()/addCapability()
  // calls as they happen, which (see com.gruijter.powerhour's original
  // version of this same pattern) can turn what should be an O(n)
  // migration into O(n^2) round trips. See
  // com.gruijter.powerhour/lib/DeviceMigrator.js#migrateCapabilities for
  // the reference implementation this mirrors.
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
  // what the vehicle itself reports (`imperial`, derived in device.js#mapStatus()
  // from the raw API's own per-field unit code — see lib/distance_convert.js). Not
  // driven by a device setting or Homey's own i18n.getUnits() (confirmed
  // unreliable, see homey-app-development skill section 9) — only by what this
  // specific car/account is actually configured for. Only calls
  // setCapabilityOptions when the unit has actually changed, and always merges
  // onto the manifest-declared options rather than passing {units, decimals}
  // alone, so a per-capability title override isn't silently dropped (same
  // pattern as com.gruijter.powerhour/lib/DeviceMigrator.js's currency/meter
  // options migration).
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
  // Drivetrain.FuelSystem.AverageFuelEconomy.Unit code — see FUEL_ECONOMY_UNITS
  // above for the confidence level per code (4 reasonably confirmed; 1 and 5
  // single-capture guesses, NEEDS CONFIRMATION). `afeUnitCode` and `imperial` are
  // both read from device.js#mapStatus() (`this.fuelEconomyUnit`,
  // `this.imperialDistance`). An unrecognized/missing code (0, undefined, or any
  // value other than 1/4/5) is left alone entirely — the compose-time default
  // ("km/kWh", from .homeycompose) stays in place rather than guessing further.
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
