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

const EventEmitter = require('events');
const VehicleManager = require('./native/VehicleManager');
const Vehicle = require('./native/Vehicle');
const {
  REGION_EUROPE, REGION_USA, REGION_CANADA, REGION_AUSTRALIA, REGION_CHINA,
  BRAND_KIA, BRAND_HYUNDAI,
} = require('./native/const');
const exceptions = require('./native/exceptions');

const REGION_MAP = {
  EU: REGION_EUROPE, US: REGION_USA, CA: REGION_CANADA, AU: REGION_AUSTRALIA, CN: REGION_CHINA,
};
const BRAND_MAP = { kia: BRAND_KIA, hyundai: BRAND_HYUNDAI };

// Replaces the former `new (require('bluelinky').BlueLinky)(options)`:
// same constructor shape and the same 'ready'/'error' events, so
// drivers/car/driver.js and device.js otherwise stay unchanged.
class NativeClient extends EventEmitter {
  constructor(options) {
    super();
    this.manager = new VehicleManager({
      username: options.username,
      password: options.password,
      pin: options.pin,
      region: REGION_MAP[options.region],
      brand: BRAND_MAP[options.brand],
      language: options.language,
      // Usually { log: this.log.bind(this), error: this.error.bind(this) }
      // from device.js/driver.js — see ../NAMING.md.
      logger: options.logger,
    });
    this.vehicles = [];
    if (options.autoLogin) {
      this.login().catch(() => {}); // error also comes through the 'error' event
    }
  }

  async login() {
    let vehicleConfigs;
    try {
      vehicleConfigs = await this.manager.login();
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
    // Outside the try/catch: an error thrown by a 'ready' listener itself is
    // not a login/API error and shouldn't be reported again as an 'error' event.
    this.vehicles = vehicleConfigs.map((vehicleConfig) => new Vehicle(this.manager, vehicleConfig));
    this.emit('ready', this.vehicles);
    return this.vehicles;
  }
}

function createClient(options) {
  return new NativeClient(options);
}

// exceptions: exposed so drivers/car/device.js can recognize error types
// (e.g. AuthenticationError) to show an understandable unavailable message
// instead of the generic "Device is restarting" fallback.
module.exports = { createClient, NativeClient, exceptions };
