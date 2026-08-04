'use strict';

const EventEmitter = require('events');
const VehicleManager = require('./native/VehicleManager');
const Vehicle = require('./native/Vehicle');
const {
  REGION_EUROPE, REGION_USA, REGION_CANADA, REGION_AUSTRALIA, REGION_CHINA,
  BRAND_KIA, BRAND_HYUNDAI,
} = require('./native/const');

// Regio's die al native geport zijn (zie het plan in
// /home/robin/.claude/plans/deze-repo-is-heeft-keen-summit.md, Fase 3 voor de
// volgorde). Overige regio's vallen terug op bluelinky tot ze zijn geport.
const NATIVE_REGIONS = new Set(['EU']);

const REGION_MAP = {
  EU: REGION_EUROPE, US: REGION_USA, CA: REGION_CANADA, AU: REGION_AUSTRALIA, CN: REGION_CHINA,
};
const BRAND_MAP = { kia: BRAND_KIA, hyundai: BRAND_HYUNDAI };

// Drop-in vervanger van `new (require('bluelinky').BlueLinky)(options)`:
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
  if (NATIVE_REGIONS.has(options.region)) {
    return new NativeClient(options);
  }
  // eslint-disable-next-line global-require
  const { BlueLinky } = require('bluelinky');
  return new BlueLinky(options);
}

module.exports = { createClient, NativeClient };
