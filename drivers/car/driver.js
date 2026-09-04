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
const { createClient, exceptions } = require('../../lib/connect');
const DeviceMigrator = require('../../lib/DeviceMigrator');

const LOGIN_TIMEOUT_MS = 15 * 1000;

const timeout = (homey, ms) => new Promise((_, reject) => {
  homey.setTimeout(() => reject(Error('timeout')), ms);
});

module.exports = class MyDriver extends Homey.Driver {

  async onInit() {
    this.capabilitiesMap = {
      'Full EV ccuCCS2': ['target_temperature', 'charge_target_slow', 'charge_target_fast', 'refresh_status', 'charge',
        'defrost', 'climate_control', 'departure_schedule.1', 'departure_schedule.2', 'flash_lights', 'flash_lights_and_honk', 'vent_windows', 'valet_mode', 'locked',
        'last_refresh', 'engine', 'closed_locked', 'location', 'meter_distance', 'measure_speed',
        'measure_range', 'ev_charging_state', 'departure_time', 'measure_power.charge', 'meter_power.fuel_economy', 'measure_odo',
        'alarm_tire_pressure', 'alarm_bat', 'alarm_generic.washer_fluid', 'alarm_generic.brake_fluid', 'alarm_generic.key_fob_battery', 'measure_battery', 'measure_battery.12V', 'measure_battery.health', 'latitude', 'longitude'],

      'Full EV': ['target_temperature', 'charge_target_slow', 'charge_target_fast', 'refresh_status', 'charge',
        'defrost', 'climate_control', 'departure_schedule.1', 'departure_schedule.2', 'flash_lights', 'flash_lights_and_honk', 'valet_mode', 'locked',
        'last_refresh', 'engine', 'closed_locked', 'location', 'meter_distance', 'measure_speed',
        'measure_range', 'ev_charging_state', 'departure_time', 'measure_odo', 'alarm_tire_pressure', 'alarm_bat', 'alarm_generic.washer_fluid', 'alarm_generic.brake_fluid', 'alarm_generic.key_fob_battery',
        'measure_battery', 'measure_battery.12V', 'latitude', 'longitude'],

      PHEV: ['target_temperature', 'refresh_status', 'charge', 'defrost', 'climate_control', 'departure_schedule.1', 'departure_schedule.2', 'flash_lights', 'flash_lights_and_honk', 'valet_mode', 'locked',
        'last_refresh', 'engine', 'closed_locked',
        'location', 'meter_distance', 'measure_speed', 'measure_range', 'ev_charging_state', 'departure_time', 'measure_odo',
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
      // generation, even within the 'Full EV ccuCCS2' bucket. NOTE: several
      // ccuCCS2-only flow cards (windows/charge-port/charging-current/V2L
      // actions) used to filter on `capabilities=measure_battery.health` as
      // a stand-in for "is this vehicle CCS2" — that broke the moment this
      // capability could be pruned for a genuinely-CCS2 car that just
      // doesn't report SoH, so those filters now key on `vent_windows`
      // instead (also ccuCCS2-only, but not derived from live telemetry).
      // Do NOT add `vent_windows` to this array, or the same bug recurs.
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
    return correctCaps.filter((cap) => !this.capabilitiesToCheck.includes(cap) || !this.isUnsupportedValue(status[cap]));
  }

  // The "this car doesn't report it" test, shared with Device#recordSeenCaps()
  // so the evidence a capability is *kept* on is gathered by exactly the same
  // rule that would drop it.
  isUnsupportedValue(value) {
    return value === undefined || value === null || Number.isNaN(value);
  }

  // Logs in with the credentials from the pair/repair form and confirms the
  // PIN, throwing the same localized errors either flow shows. Shared so a
  // repair validates exactly what pairing validates.
  async validateCredentials(settings) {
    this.log('validating credentials');
    if (settings.pin.length !== 4) {
      throw Error(this.homey.__('pair.invalid_pin'));
    }
    const manager = createClient({
      username: settings.username,
      password: settings.password,
      pin: settings.pin,
      brand: this.homey.manifest.id.replace('com.', ''), // 'kia' or 'hyundai'
      region: settings.region,
      logger: { log: this.log.bind(this), error: this.error.bind(this) },
    });
    let vehicleConfigs;
    try {
      vehicleConfigs = await Promise.race([manager.login(), timeout(this.homey, LOGIN_TIMEOUT_MS)]);
    } catch (error) {
      this.error(error);
      if (error instanceof exceptions.NetworkError || error instanceof exceptions.RequestTimeoutError) {
        throw Error(this.homey.__('pair.network_error'));
      }
      throw Error(this.homey.__('pair.pairing_failed', { error: error.message || error }));
    }
    if (!vehicleConfigs || !Array.isArray(vehicleConfigs) || vehicleConfigs.length < 1) {
      this.error('No vehicles in this account!');
      throw Error(this.homey.__('pair.no_vehicles'));
    }
    try {
      await manager.odometer(vehicleConfigs[0]); // confirms the PIN is correct
    } catch {
      this.error('Incorrect PIN!');
      throw Error(this.homey.__('pair.invalid_pin'));
    }
    this.log('CREDENTIALS OK!');
    return { manager, vehicleConfigs };
  }

  // Which capabilitiesMap bucket this vehicle belongs in. Derived from a raw
  // status + the vehicle's own protocol flag, so it can only be done where
  // both are at hand: pairing, repair, or a poll — never Device#migrate(),
  // which runs before login and only has the mapped status to go on.
  deriveEngine(status, vehicleConfig) {
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
    return engine;
  }

  // The complete device settings a pairing produces — every one of them
  // re-derived, so a repair can write the identical set over an existing
  // device instead of leaving stale values behind.
  buildDeviceSettings(credentials, vehicleConfig, engine) {
    return {
      username: credentials.username,
      password: credentials.password,
      pin: credentials.pin,
      region: credentials.region,
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
    };
  }

  onPair(session) {
    try {
      this.log('Pairing of car started');

      let settings;
      let manager;
      let vehicleConfigs = [];

      session.setHandler('validate', async (data) => {
        settings = data;
        ({ manager, vehicleConfigs } = await this.validateCredentials(data));
        return true;
      });

      session.setHandler('list_devices', async () => {
        this.log('listing of devices started');
        const devices = vehicleConfigs.map(async (vehicleConfig) => {
          this.log(vehicleConfig);
          const status = await manager.updateVehicleWithCachedState(vehicleConfig);
          // console.dir(status, { depth: null, colors: true });
          const engine = this.deriveEngine(status, vehicleConfig);
          return {
            name: vehicleConfig.nickname,
            data: {
              id: vehicleConfig.vin,
            },
            settings: this.buildDeviceSettings(settings, vehicleConfig, engine),
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

  // Re-runs a full pairing against an existing device: same credential form,
  // same login, same engine derivation, same settings and capability list —
  // then throws away everything the device had learned since it was paired
  // (stored status, per-capability evidence, park location, applied unit
  // labels), so it comes up as if it had just been added. Recovers a device
  // whose settings went stale or were never written by the version that
  // paired it (a missing `engine` disables Device#migrate() entirely), and
  // re-buckets a car whose protocol changed under it (ccuCCS2 after a
  // firmware update) — neither of which any restart can fix.
  onRepair(session, device) {
    let credentials;
    let manager;
    let vehicleConfigs = [];

    session.setHandler('validate', async (data) => {
      credentials = data;
      ({ manager, vehicleConfigs } = await this.validateCredentials(data));
      return true;
    });

    session.setHandler('repair', async () => {
      const vin = device.getData().id;
      this.log(`repairing ${device.getName()} (${vin})`);
      const vehicleConfig = vehicleConfigs.find((vc) => vc.vin === vin);
      // The account no longer holds this car (sold, or unshared) — the same
      // situation Device#setupClient() reports, so the same message.
      if (!vehicleConfig) throw Error(this.homey.__('device_no_vehicle', { vin }));

      const status = await manager.updateVehicleWithCachedState(vehicleConfig);
      const engine = this.deriveEngine(status, vehicleConfig);
      await device.setSettings(this.buildDeviceSettings(credentials, vehicleConfig, engine));
      await DeviceMigrator.migrateCapabilities(device, this.filterSupportedCapabilities(
        this.capabilitiesMap[engine],
        this.extractCheckableStatus(status),
      ));
      // Store keys a fresh pairing wouldn't have. Left behind they'd outvote
      // what this repair just established: `seenCaps` keeps pruned-away
      // capabilities alive, and the unit markers suppress the next poll's
      // unit write (see DeviceMigrator#reconcileUnitMarkers).
      const stale = ['lastStatus', 'seenCaps', 'parkLocation', 'appliedDistanceUnits', 'appliedSpeedUnits', 'appliedFuelEconomyUnits'];
      await Promise.all(stale.map((key) => device.unsetStoreValue(key).catch((error) => this.error(error))));
      this.log(`repair of ${device.getName()} done, engine=${engine}`);
      device.restartDevice(500).catch((error) => this.error(error));
      return true;
    });
  }

};
