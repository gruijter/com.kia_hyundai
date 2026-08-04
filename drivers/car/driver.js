/*
Copyright 2025, RM de Gruijter (rmdegruijter@gmail.com)

This file is part of com.hyundai

com.hyundai is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.hyundai is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.hyundai. If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const Homey = require('homey');
const util = require('util');
const { createClient } = require('../../lib/connect');

const setTimeoutPromise = util.promisify(setTimeout);

module.exports = class MyDriver extends Homey.Driver {

  async onInit() {
    this.capabilitiesMap = {
      'Full EV ccuCCS2': ['target_temperature', 'charge_target_slow', 'charge_target_fast', 'refresh_status', 'locked',
        'defrost', 'climate_control', 'last_refresh', 'engine', 'closed_locked', 'location', 'meter_distance', 'measure_speed',
        'measure_range', 'ev_charging_state', 'measure_power.charge', 'meter_power.fuel_economy', 'charge', 'measure_odo',
        'alarm_tire_pressure', 'alarm_bat', 'measure_battery', 'measure_battery.12V', 'latitude', 'longitude'],

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
      let vehicles = [];

      session.setHandler('validate', async (data) => {
        this.log('validating credentials');
        settings = data;
        vehicles = [];

        if (settings.pin.length !== 4) {
          throw Error(this.homey.__('pair.invalid_pin'));
        }

        const options = {
          username: settings.username,
          password: settings.password,
          pin: settings.pin,
          brand: this.homey.manifest.id.replace('com.', ''), // 'kia' or 'hyundai'
          region: settings.region,
          deviceUuid: 'HomeyPair',
          autoLogin: true,
        };

        const client = createClient(options);

        const validated = await new Promise((resolve, reject) => {
          let cancelTimeout = false;
          client.on('error', (error) => {
            cancelTimeout = true;
            this.error(error);
            reject(Error(this.homey.__('pair.pairing_failed', { error: error.message || error })));
          });
          client.on('ready', (veh) => {
            cancelTimeout = true;
            if (!veh || !Array.isArray(veh) || veh.length < 1) {
              this.error('No vehicles in this account!');
              reject(Error(this.homey.__('pair.no_vehicles')));
              return;
            }
            veh[0].odometer()
              .then(() => {
                this.log('CREDENTIALS OK!');
                vehicles = veh;
                resolve(true);
              })
              .catch(() => {
                this.error('Incorrect PIN!');
                reject(Error(this.homey.__('pair.invalid_pin')));
              });
          });
          setTimeoutPromise(15 * 1000) // login timeout
            .then(() => {
              if (!cancelTimeout) {
                this.error('Login timeout!');
                reject(Error(this.homey.__('pair.pairing_failed', { error: 'timeout' })));
              }
            })
            .catch((error) => this.error(error));
        });
        return validated;
      });

      session.setHandler('list_devices', async () => {
        this.log('listing of devices started');
        const devices = vehicles.map(async (vehicle) => {
          this.log(vehicle.vehicleConfig);
          const status = await vehicle.status({ refresh: false, parsed: false });
          // console.dir(status, { depth: null, colors: true });
          const isPEV = !!status.evStatus || !!status?.Green?.ChargingInformation?.ConnectorFastening;
          const isICE = !!status.dte || !!status.fuelLevel
            || !!status?.evStatus?.drvDistance?.[0]?.rangeByFuel?.gasModeRange?.value
            || !!status?.Drivetrain?.InternalCombustionEngine;
          let engine = 'HEV/ICE';
          if (isPEV && isICE) engine = 'PHEV';
          if (isPEV && !isICE) engine = 'Full EV';
          if (isPEV && !isICE && vehicle?.vehicleConfig?.ccuCCS2ProtocolSupport) engine = 'Full EV ccuCCS2';
          return {
            name: vehicle.vehicleConfig.nickname,
            data: {
              id: vehicle.vehicleConfig.vin,
            },
            settings: {
              username: settings.username,
              password: settings.password,
              pin: settings.pin,
              region: settings.region,
              language: 'en',
              // pollInterval,
              nameOrg: vehicle.vehicleConfig.name,
              idOrg: vehicle.vehicleConfig.id,
              vin: vehicle.vehicleConfig.vin,
              regDate: vehicle.vehicleConfig.regDate.split(' ')[0],
              brandIndicator: vehicle.vehicleConfig.brandIndicator,
              generation: vehicle.vehicleConfig.generation,
              ccuCCS2ProtocolSupport: vehicle.vehicleConfig.ccuCCS2ProtocolSupport,
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
