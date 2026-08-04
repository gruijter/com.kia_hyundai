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
const { prefixLogger } = require('./logger');

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Port of VehicleManager.py: picks the region implementation, manages the
// token (login + refresh-before-expiry), and delegates commands. Logs
// milestones (login, each command) one level above the HTTP details that
// ApiImplSession already logs — together the basis for debugging non-EU
// regions via Homey diagnostic reports (no test accounts available, see
// ../NAMING.md).
class VehicleManager {
  // Port of VehicleManager.get_implementation_by_region_brand.
  static getImplementationByRegionBrand(region, brand, language, logger) {
    const opts = { logger };
    if (region === REGION_CANADA) return new KiaUvoApiCA(region, brand, language, opts);
    if (region === REGION_EUROPE) return new KiaUvoApiEU(region, brand, language, opts);
    if (region === REGION_USA && brand === BRAND_KIA) return new KiaUvoApiUSA(region, brand, language, opts);
    if (region === REGION_USA) return new HyundaiBlueLinkApiUSA(region, brand, language, opts);
    if (region === REGION_CHINA) return new KiaUvoApiCN(region, brand, language, opts);
    if (region === REGION_AUSTRALIA) return new KiaUvoApiAU(region, brand, language, opts);
    throw new Error(`No native implementation for region "${region}"`);
  }

  constructor({
    username, password, pin, region, brand, language, logger,
  }) {
    this.username = username;
    this.password = password;
    this.pin = pin;
    this.region = region;
    this.brand = brand;
    this.logger = prefixLogger(logger, `VehicleManager:${region}:${brand}`);
    this.impl = VehicleManager.getImplementationByRegionBrand(region, brand, language, logger);
    this.token = null;
  }

  async login() {
    this.logger.log('login: start');
    try {
      this.token = await this.impl.login(this.username, this.password, this.pin);
      const vehicles = await this.impl.getVehicles(this.token);
      this.logger.log(`login: OK, ${vehicles.length} vehicle(s) found`);
      return vehicles;
    } catch (error) {
      this.logger.error(`login: FAILED — ${error.constructor.name}: ${error.message}`);
      throw error;
    }
  }

  // For regions with an OTP step (CA, Kia USA on an unrecognized device).
  // Not yet wired up to a Homey pairing UI — see ../NAMING.md.
  async sendOtp(otpRequest, notifyType) {
    this.logger.log(`sendOtp: start (notifyType=${notifyType})`);
    try {
      const result = await this.impl.sendOtp(otpRequest, notifyType);
      this.logger.log('sendOtp: OK');
      return result;
    } catch (error) {
      this.logger.error(`sendOtp: FAILED — ${error.constructor.name}: ${error.message}`);
      throw error;
    }
  }

  async verifyOtpAndCompleteLogin(otpCode, otpRequest) {
    this.logger.log('verifyOtpAndCompleteLogin: start');
    try {
      this.token = await this.impl.verifyOtpAndCompleteLogin(this.username, this.password, otpCode, otpRequest, this.pin);
      const vehicles = await this.impl.getVehicles(this.token);
      this.logger.log(`verifyOtpAndCompleteLogin: OK, ${vehicles.length} vehicle(s) found`);
      return vehicles;
    } catch (error) {
      this.logger.error(`verifyOtpAndCompleteLogin: FAILED — ${error.constructor.name}: ${error.message}`);
      throw error;
    }
  }

  async _ensureValidToken() {
    if (!this.token) throw new Error('Not logged in');
    if (this.token.validUntil.getTime() - TOKEN_REFRESH_BUFFER_MS < Date.now()) {
      this.logger.log('token: refreshing (near expiry)');
      try {
        this.token = await this.impl.refreshAccessToken(this.token);
        this.logger.log('token: refreshed OK');
      } catch (error) {
        this.logger.error(`token: refresh FAILED — ${error.constructor.name}: ${error.message}`);
        throw error;
      }
    }
  }

  async _call(method, vehicleConfig, ...args) {
    await this._ensureValidToken();
    const vehicleLabel = (vehicleConfig && (vehicleConfig.vin || vehicleConfig.id)) || 'unknown';
    this.logger.log(`${method}: start (vehicle=${vehicleLabel})`);
    try {
      const result = await this.impl[method](this.token, vehicleConfig, ...args);
      this.logger.log(`${method}: OK (vehicle=${vehicleLabel})`);
      return result;
    } catch (error) {
      this.logger.error(`${method}: FAILED (vehicle=${vehicleLabel}) — ${error.constructor.name}: ${error.message}`);
      throw error;
    }
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
