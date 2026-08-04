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

// Vervangt de vroegere `new (require('bluelinky').BlueLinky)(options)`:
// zelfde constructor-vorm en dezelfde 'ready'/'error' events, zodat
// drivers/car/driver.js en device.js verder ongewijzigd blijven.
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
      // Meestal { log: this.log.bind(this), error: this.error.bind(this) }
      // vanuit device.js/driver.js — zie ../NAMING.md.
      logger: options.logger,
    });
    this.vehicles = [];
    if (options.autoLogin) {
      this.login().catch(() => {}); // fout komt ook via het 'error' event
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
    // Buiten de try/catch: een fout die een 'ready'-listener zelf gooit is geen
    // login/API-fout en moet niet nogmaals als 'error' event gerapporteerd worden.
    this.vehicles = vehicleConfigs.map((vehicleConfig) => new Vehicle(this.manager, vehicleConfig));
    this.emit('ready', this.vehicles);
    return this.vehicles;
  }
}

function createClient(options) {
  return new NativeClient(options);
}

// exceptions: exposed zodat drivers/car/device.js foutsoorten kan herkennen
// (bv. AuthenticationError) om een begrijpelijke unavailable-melding te tonen
// i.p.v. de generieke "Device is restarting" fallback.
module.exports = { createClient, NativeClient, exceptions };
