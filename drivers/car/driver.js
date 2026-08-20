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
      'Full EV ccuCCS2': ['target_temperature', 'charge_target_slow', 'charge_target_fast', 'refresh_status', 'locked',
        'defrost', 'climate_control', 'last_refresh', 'engine', 'closed_locked', 'location', 'meter_distance', 'measure_speed',
        'measure_range', 'ev_charging_state', 'measure_power.charge', 'meter_power.fuel_economy', 'charge', 'measure_odo',
        'alarm_tire_pressure', 'alarm_bat', 'measure_battery', 'measure_battery.12V', 'measure_battery.health', 'latitude', 'longitude'],

      'Full EV': ['target_temperature', 'charge_target_slow', 'charge_target_fast', 'refresh_status', 'locked',
        'defrost', 'climate_control', 'last_refresh', 'engine', 'closed_locked', 'location', 'meter_distance', 'measure_speed',
        'measure_range', 'ev_charging_state', 'charge', 'measure_odo', 'alarm_tire_pressure', 'alarm_bat',
        'measure_battery', 'measure_battery.12V', 'latitude', 'longitude'],

      PHEV: ['target_temperature', 'refresh_status', 'locked', 'defrost', 'climate_control', 'last_refresh', 'engine', 'closed_locked',
        'location', 'meter_distance', 'measure_speed', 'measure_range', 'ev_charging_state', 'charge', 'measure_odo',
        'alarm_tire_pressure', 'alarm_bat', 'measure_battery', 'measure_battery.12V', 'latitude', 'longitude'],

      'HEV/ICE': ['target_temperature', 'refresh_status', 'locked', 'defrost', 'climate_control', 'last_refresh', 'engine',
        'closed_locked', 'location', 'meter_distance', 'measure_speed', 'measure_range', 'measure_odo', 'alarm_tire_pressure',
        'alarm_bat', 'measure_battery.12V', 'latitude', 'longitude'],
    };

    this.log('Driver has been initialized');
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
            capabilities: this.capabilitiesMap[engine],
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
