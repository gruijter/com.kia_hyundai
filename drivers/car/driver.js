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

const Homey = require('homey');
const { createClient } = require('../../lib/connect');

const LOGIN_TIMEOUT_MS = 15 * 1000;

const timeout = (ms) => new Promise((_, reject) => {
  setTimeout(() => reject(Error('timeout')), ms);
});

module.exports = class MyDriver extends Homey.Driver {

  async onInit() {
    this.capabilitiesMap = {
      'Full EV ccuCCS2': ['target_temperature', 'charge_target_slow', 'charge_target_fast', 'refresh_status', 'charge',
        'defrost', 'climate_control', 'flash_lights', 'flash_lights_and_honk', 'vent_windows', 'valet_mode', 'locked',
        'last_refresh', 'engine', 'closed_locked', 'location', 'meter_distance', 'measure_speed',
        'measure_range', 'ev_charging_state', 'measure_power.charge', 'meter_power.fuel_economy', 'measure_odo',
        'alarm_tire_pressure', 'alarm_bat', 'alarm_generic.washer_fluid', 'alarm_generic.brake_fluid', 'alarm_generic.key_fob_battery', 'measure_battery', 'measure_battery.12V', 'measure_battery.health', 'latitude', 'longitude'],

      'Full EV': ['target_temperature', 'charge_target_slow', 'charge_target_fast', 'refresh_status', 'charge',
        'defrost', 'climate_control', 'flash_lights', 'flash_lights_and_honk', 'valet_mode', 'locked',
        'last_refresh', 'engine', 'closed_locked', 'location', 'meter_distance', 'measure_speed',
        'measure_range', 'ev_charging_state', 'measure_odo', 'alarm_tire_pressure', 'alarm_bat', 'alarm_generic.washer_fluid', 'alarm_generic.brake_fluid', 'alarm_generic.key_fob_battery',
        'measure_battery', 'measure_battery.12V', 'latitude', 'longitude'],

      PHEV: ['target_temperature', 'refresh_status', 'charge', 'defrost', 'climate_control', 'flash_lights', 'flash_lights_and_honk', 'valet_mode', 'locked',
        'last_refresh', 'engine', 'closed_locked',
        'location', 'meter_distance', 'measure_speed', 'measure_range', 'ev_charging_state', 'measure_odo',
        'alarm_tire_pressure', 'alarm_bat', 'alarm_generic.washer_fluid', 'alarm_generic.brake_fluid', 'alarm_generic.key_fob_battery', 'measure_battery', 'measure_battery.12V', 'latitude', 'longitude'],

      'HEV/ICE': ['target_temperature', 'refresh_status', 'defrost', 'climate_control', 'flash_lights',
        'flash_lights_and_honk', 'valet_mode', 'locked', 'last_refresh', 'engine',
        'closed_locked', 'location', 'meter_distance', 'measure_speed', 'measure_range', 'measure_odo', 'alarm_tire_pressure',
        'alarm_bat', 'alarm_generic.washer_fluid', 'alarm_generic.brake_fluid', 'alarm_generic.key_fob_battery',
        'measure_battery.12V', 'latitude', 'longitude'],
    };

    // capabilitiesMap only distinguishes by engine type (EV/PHEV/HEV/ICE,
    // CCS2 vs legacy) but a handful of capabilities also depend on
    // vehicle-specific equipment/firmware that varies *within* one engine
    // bucket and can't be known from the engine type alone. mapStatus()
    // (device.js) leaves these fields `undefined` rather than coercing them
    // to `false`/`0`/`null` exactly when the raw vehicle status has no data
    // for them, so `undefined` (or NaN, for the one arithmetic field) is
    // used as the "this car doesn't report it" signal — see
    // extractCheckableStatus() / filterSupportedCapabilities() below, called
    // from onPair() here and from Device#migrate().
    this.capabilitiesToCheck = [
      // Confirmed: only reported by some (legacy/non-CCS2) models, absent
      // and permanently unset on others regardless of engine type — see the
      // comment above the `alarm_generic.washer_fluid` line in
      // device.js#mapStatus().
      'alarm_generic.washer_fluid',
      'alarm_generic.brake_fluid',
      'alarm_generic.key_fob_battery',
      // Battery State-of-Health isn't reported by every EV/firmware
      // generation, even within the 'Full EV ccuCCS2' bucket.
      'measure_battery.health',
      // CCS2-only; when unsupported this currently computes as
      // `undefined * 1000` = NaN instead of staying unset, which throws in
      // setCapabilityValue() every poll cycle — pruning the capability here
      // fixes that too.
      'measure_power.charge',
    ];

    this.log('Driver has been initialized');
  }

  // Pulls just the capabilitiesToCheck fields out of a raw vehicle status
  // response (either the legacy `sts.time` shape or the CCS2 `sts.Date`
  // shape — mirrors the equivalent lines in device.js#mapStatus(), kept in
  // sync manually since mapStatus() itself needs a live Device instance
  // (settings/getCapabilityValue) for the fields not covered here).
  extractCheckableStatus(rawStatus) {
    const result = {};
    if (!rawStatus) return result;
    let sts = { ...rawStatus };
    if (sts.vehicleStatus) sts = { ...sts.vehicleStatus };
    if (sts.time) { // legacy/simple status
      result['alarm_generic.washer_fluid'] = sts?.washerFluidStatus;
      result['alarm_generic.brake_fluid'] = sts?.breakOilStatus;
      result['alarm_generic.key_fob_battery'] = sts?.smartKeyBatteryWarning;
      result['measure_battery.health'] = sts?.evStatus?.batterySoh;
      result['measure_power.charge'] = undefined; // never reported on legacy status
    }
    if (sts.Date) { // CCS2 status
      result['alarm_generic.washer_fluid'] = sts?.Body?.Windshield?.Front?.WasherFluid?.LevelLow;
      result['alarm_generic.brake_fluid'] = sts?.Chassis?.Brake?.Fluid?.Warning;
      result['alarm_generic.key_fob_battery'] = sts?.Electronics?.FOB?.LowBattery;
      result['measure_battery.health'] = sts?.Green?.BatteryManagement?.SoH?.Ratio;
      result['measure_power.charge'] = sts?.Green?.Electric?.SmartGrid?.RealTimePower;
    }
    return result;
  }

  // Drops any capability listed in capabilitiesToCheck that `status` shows
  // no data for. `status` can be either extractCheckableStatus()'s output
  // (pairing, raw status) or a device's already-mapped stored `lastStatus`
  // (migration) — both key the checked fields by the same capability names.
  filterSupportedCapabilities(correctCaps, status) {
    if (!status) return correctCaps;
    const isUnsupported = (value) => value === undefined || value === null || Number.isNaN(value);
    return correctCaps.filter((cap) => !this.capabilitiesToCheck.includes(cap) || !isUnsupported(status[cap]));
  }

  onPair(session) {
    try {
      this.log('Pairing of car started');

      let settings;
      let manager;
      let vehicleConfigs = [];

      session.setHandler('validate', async (data) => {
        this.log('validating credentials');
        settings = data;
        vehicleConfigs = [];

        if (settings.pin.length !== 4) {
          throw Error(this.homey.__('pair.invalid_pin'));
        }

        const options = {
          username: settings.username,
          password: settings.password,
          pin: settings.pin,
          brand: this.homey.manifest.id.replace('com.', ''), // 'kia' or 'hyundai'
          region: settings.region,
          logger: { log: this.log.bind(this), error: this.error.bind(this) },
        };

        manager = createClient(options);

        let veh;
        try {
          veh = await Promise.race([manager.login(), timeout(LOGIN_TIMEOUT_MS)]);
        } catch (error) {
          this.error(error);
          throw Error(this.homey.__('pair.pairing_failed', { error: error.message || error }));
        }
        if (!veh || !Array.isArray(veh) || veh.length < 1) {
          this.error('No vehicles in this account!');
          throw Error(this.homey.__('pair.no_vehicles'));
        }
        try {
          await manager.odometer(veh[0]); // confirms the PIN is correct
        } catch {
          this.error('Incorrect PIN!');
          throw Error(this.homey.__('pair.invalid_pin'));
        }
        this.log('CREDENTIALS OK!');
        vehicleConfigs = veh;
        return true;
      });

      session.setHandler('list_devices', async () => {
        this.log('listing of devices started');
        const devices = vehicleConfigs.map(async (vehicleConfig) => {
          this.log(vehicleConfig);
          const status = await manager.updateVehicleWithCachedState(vehicleConfig);
          // console.dir(status, { depth: null, colors: true });
          // legacy (non-ccuCCS2) vehicles nest evStatus/dte/fuelLevel one level
          // deeper, under vehicleStatus — CCS2 vehicles are already flat here.
          const legacyStatus = status?.vehicleStatus || status;
          const isPEV = !!legacyStatus.evStatus || !!status?.Green?.ChargingInformation?.ConnectorFastening;
          const isICE = !!legacyStatus.dte || !!legacyStatus.fuelLevel
            || !!legacyStatus?.evStatus?.drvDistance?.[0]?.rangeByFuel?.gasModeRange?.value
            || !!status?.Drivetrain?.InternalCombustionEngine;
          let engine = 'HEV/ICE';
          if (isPEV && isICE) engine = 'PHEV';
          if (isPEV && !isICE) engine = 'Full EV';
          if (isPEV && !isICE && vehicleConfig?.ccuCCS2ProtocolSupport) engine = 'Full EV ccuCCS2';
          return {
            name: vehicleConfig.nickname,
            data: {
              id: vehicleConfig.vin,
            },
            settings: {
              username: settings.username,
              password: settings.password,
              pin: settings.pin,
              region: settings.region,
              language: 'en',
              // pollInterval,
              nameOrg: vehicleConfig.name,
              idOrg: vehicleConfig.id,
              vin: vehicleConfig.vin,
              regDate: vehicleConfig.regDate.split(' ')[0],
              brandIndicator: vehicleConfig.brandIndicator,
              generation: vehicleConfig.generation,
              ccuCCS2ProtocolSupport: vehicleConfig.ccuCCS2ProtocolSupport,
              engine,
              lat: Math.round(this.homey.geolocation.getLatitude() * 100000000) / 100000000,
              lon: Math.round(this.homey.geolocation.getLongitude() * 100000000) / 100000000,
            },
            capabilities: this.filterSupportedCapabilities(
              this.capabilitiesMap[engine],
              this.extractCheckableStatus(status),
            ),
          };
        });
        // console.log(await Promise.all(devices));
        return Promise.all(devices);
      });
    } catch (error) {
      this.error(error);
    }
  }

};
