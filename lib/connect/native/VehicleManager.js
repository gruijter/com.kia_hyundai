'use strict';

const {
  REGION_EUROPE, REGION_CANADA, REGION_USA, REGION_CHINA, REGION_AUSTRALIA,
  BRAND_KIA, VEHICLE_LOCK_ACTION,
} = require('./const');
const KiaUvoApiEU = require('./regions/KiaUvoApiEU');
const KiaUvoApiAU = require('./regions/KiaUvoApiAU');
const KiaUvoApiCN = require('./regions/KiaUvoApiCN');
const KiaUvoApiCA = require('./regions/KiaUvoApiCA');
const KiaUvoApiUSA = require('./regions/KiaUvoApiUSA');
const HyundaiBlueLinkApiUSA = require('./regions/HyundaiBlueLinkApiUSA');

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Poort van VehicleManager.py: kiest de regio-implementatie, beheert het
// token (login + refresh-before-expiry) en delegeert commando's.
class VehicleManager {
  // Poort van VehicleManager.get_implementation_by_region_brand.
  static getImplementationByRegionBrand(region, brand, language) {
    if (region === REGION_CANADA) return new KiaUvoApiCA(region, brand, language);
    if (region === REGION_EUROPE) return new KiaUvoApiEU(region, brand, language);
    if (region === REGION_USA && brand === BRAND_KIA) return new KiaUvoApiUSA(region, brand, language);
    if (region === REGION_USA) return new HyundaiBlueLinkApiUSA(region, brand, language);
    if (region === REGION_CHINA) return new KiaUvoApiCN(region, brand, language);
    if (region === REGION_AUSTRALIA) return new KiaUvoApiAU(region, brand, language);
    throw new Error(`No native implementation for region "${region}"`);
  }

  constructor({
    username, password, pin, region, brand, language,
  }) {
    this.username = username;
    this.password = password;
    this.pin = pin;
    this.impl = VehicleManager.getImplementationByRegionBrand(region, brand, language);
    this.token = null;
  }

  async login() {
    this.token = await this.impl.login(this.username, this.password, this.pin);
    const vehicles = await this.impl.getVehicles(this.token);
    return vehicles;
  }

  // Voor regio's met een OTP-stap (CA, Kia USA bij een onbekend apparaat).
  // Nog niet aangesloten op een Homey pairing-UI — zie ../NAMING.md.
  sendOtp(otpRequest, notifyType) {
    return this.impl.sendOtp(otpRequest, notifyType);
  }

  async verifyOtpAndCompleteLogin(otpCode, otpRequest) {
    this.token = await this.impl.verifyOtpAndCompleteLogin(this.username, this.password, otpCode, otpRequest, this.pin);
    return this.impl.getVehicles(this.token);
  }

  async _ensureValidToken() {
    if (!this.token) throw new Error('Not logged in');
    if (this.token.validUntil.getTime() - TOKEN_REFRESH_BUFFER_MS < Date.now()) {
      this.token = await this.impl.refreshAccessToken(this.token);
    }
  }

  async _call(method, vehicleConfig, ...args) {
    await this._ensureValidToken();
    return this.impl[method](this.token, vehicleConfig, ...args);
  }

  updateVehicleWithCachedState(vehicleConfig) {
    return this._call('updateVehicleWithCachedState', vehicleConfig);
  }

  forceRefreshVehicleState(vehicleConfig) {
    return this._call('forceRefreshVehicleState', vehicleConfig);
  }

  odometer(vehicleConfig) {
    return this._call('odometer', vehicleConfig);
  }

  getLocation(vehicleConfig) {
    return this._call('getLocation', vehicleConfig);
  }

  lock(vehicleConfig) {
    return this._call('lockAction', vehicleConfig, VEHICLE_LOCK_ACTION.LOCK);
  }

  unlock(vehicleConfig) {
    return this._call('lockAction', vehicleConfig, VEHICLE_LOCK_ACTION.UNLOCK);
  }

  startClimate(vehicleConfig, options) {
    return this._call('startClimate', vehicleConfig, options);
  }

  stopClimate(vehicleConfig) {
    return this._call('stopClimate', vehicleConfig);
  }

  startCharge(vehicleConfig) {
    return this._call('startCharge', vehicleConfig);
  }

  stopCharge(vehicleConfig) {
    return this._call('stopCharge', vehicleConfig);
  }

  setChargeLimits(vehicleConfig, ac, dc) {
    return this._call('setChargeLimits', vehicleConfig, ac, dc);
  }

  chargePortAction(vehicleConfig, action) {
    return this._call('chargePortAction', vehicleConfig, action);
  }

  setNavigation(vehicleConfig, poiList) {
    return this._call('setNavigation', vehicleConfig, poiList);
  }
}

module.exports = VehicleManager;
