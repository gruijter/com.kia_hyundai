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
  REGION_EUROPE, REGION_EUROPE_CCI, REGION_CANADA, REGION_USA, REGION_CHINA, REGION_AUSTRALIA,
  REGION_NZ, REGION_INDIA, REGION_BRAZIL,
  BRAND_KIA, BRAND_GENESIS, VEHICLE_LOCK_ACTION,
} = require('./const');
const KiaUvoApiEU = require('./regions/KiaUvoApiEU');
const KiaCciApiEU = require('./regions/KiaCciApiEU');
const HyundaiCciApiEU = require('./regions/HyundaiCciApiEU');
const KiaUvoApiAU = require('./regions/KiaUvoApiAU');
const KiaUvoApiCN = require('./regions/KiaUvoApiCN');
const KiaUvoApiCA = require('./regions/KiaUvoApiCA');
const KiaUvoApiUSA = require('./regions/KiaUvoApiUSA');
const HyundaiBlueLinkApiUSA = require('./regions/HyundaiBlueLinkApiUSA');
const KiaUvoApiIN = require('./regions/KiaUvoApiIN');
const HyundaiBlueLinkApiBR = require('./regions/HyundaiBlueLinkApiBR');
const { prefixLogger } = require('./logger');

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
// Deviation from upstream: check_and_refresh_token calls test_token once per
// update cycle, but _ensureValidToken runs before every single command (a
// poll makes several), so only test once per window. Only CA and GSPA have a
// real testToken; the ApiImpl default returns true without a request.
const TOKEN_TEST_INTERVAL_MS = 5 * 60 * 1000;

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
    if (region === REGION_EUROPE_CCI) {
      if (brand === BRAND_KIA) return new KiaCciApiEU(region, brand, language, opts);
      if (brand === BRAND_GENESIS) throw new Error('Genesis EU CCI/GSPA is not supported yet');
      return new HyundaiCciApiEU(region, brand, language, opts);
    }
    if (region === REGION_USA && brand === BRAND_KIA) return new KiaUvoApiUSA(region, brand, language, opts);
    if (region === REGION_USA) return new HyundaiBlueLinkApiUSA(region, brand, language, opts);
    if (region === REGION_CHINA) return new KiaUvoApiCN(region, brand, language, opts);
    if (region === REGION_AUSTRALIA) return new KiaUvoApiAU(region, brand, language, opts);
    // Same class as Australia, with its own NZ constants — and Kia only,
    // exactly as upstream: there is no Hyundai NZ backend.
    if (region === REGION_NZ && brand === BRAND_KIA) return new KiaUvoApiAU(region, brand, language, opts);
    if (region === REGION_NZ) throw new Error(`Unknown brand "${brand}" for region "${region}"`);
    if (region === REGION_INDIA) return new KiaUvoApiIN(region, brand, language, opts);
    if (region === REGION_BRAZIL) return new HyundaiBlueLinkApiBR(region, brand, language, opts);
    throw new Error(`No native implementation for region "${region}"`);
  }

  constructor({
    username, password, pin, region, brand, language, logger, deviceAuth,
  }) {
    this.username = username;
    this.password = password;
    this.pin = pin;
    this.region = region;
    this.brand = brand;
    this.logger = prefixLogger(logger, `VehicleManager:${region}:${brand}`);
    this.impl = VehicleManager.getImplementationByRegionBrand(region, brand, language, logger);
    this.token = null;
    this.tokenTestedAt = 0;
    // Only set for CA / Kia US devices that completed an OTP login.
    if (deviceAuth && this.impl.restoreDeviceAuth) this.impl.restoreDeviceAuth(deviceAuth);
  }

  async login() {
    this.logger.log('login: start');
    try {
      this.token = await this.impl.login(this.username, this.password, this.pin);
      this.tokenTestedAt = Date.now();
      const vehicles = await this.impl.getVehicles(this.token);
      this.logger.log(`login: OK, ${vehicles.length} vehicle(s) found`);
      return vehicles;
    } catch (error) {
      this.logger.error(`login: FAILED — ${error.constructor.name}: ${error.message}`);
      throw error;
    }
  }

  // For regions with an OTP step (CA, Kia USA on an unrecognized device):
  // login() then throws AuthenticationOTPRequired carrying `.otpRequest`.
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
      this.tokenTestedAt = Date.now();
      const vehicles = await this.impl.getVehicles(this.token);
      this.logger.log(`verifyOtpAndCompleteLogin: OK, ${vehicles.length} vehicle(s) found`);
      return vehicles;
    } catch (error) {
      this.logger.error(`verifyOtpAndCompleteLogin: FAILED — ${error.constructor.name}: ${error.message}`);
      throw error;
    }
  }

  // State to persist after an OTP login, for the deviceAuth constructor option.
  getDeviceAuth() {
    return this.impl.getDeviceAuth ? this.impl.getDeviceAuth() : null;
  }

  // Port of check_and_refresh_token: refresh when near expiry or when the
  // server already invalidated the token (test_token, e.g. CA 7606 after an
  // IP change), then refresh_vehicles — Kia USA's vehicle key is session
  // specific (no-op for the other regions).
  async _ensureValidToken(vehicleConfig) {
    if (!this.token) throw new Error('Not logged in');
    let reason = null;
    if (this.token.validUntil.getTime() - TOKEN_REFRESH_BUFFER_MS < Date.now()) {
      reason = 'near expiry';
    } else if (Date.now() - this.tokenTestedAt > TOKEN_TEST_INTERVAL_MS) {
      this.tokenTestedAt = Date.now();
      if (await this.impl.testToken(this.token) === false) reason = 'rejected by server';
    }
    if (!reason) return;
    this.logger.log(`token: refreshing (${reason})`);
    try {
      this.token = await this.impl.refreshAccessToken(this.token);
      this.tokenTestedAt = Date.now();
      if (vehicleConfig) await this.impl.refreshVehicles(this.token, vehicleConfig);
      this.logger.log('token: refreshed OK');
    } catch (error) {
      this.logger.error(`token: refresh FAILED — ${error.constructor.name}: ${error.message}`);
      throw error;
    }
  }

  async _call(method, vehicleConfig, ...args) {
    await this._ensureValidToken(vehicleConfig);
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

  startHazardLights(vehicleConfig) {
    return this._call('startHazardLights', vehicleConfig);
  }

  startHazardLightsAndHorn(vehicleConfig) {
    return this._call('startHazardLightsAndHorn', vehicleConfig);
  }

  setWindowsState(vehicleConfig, options) {
    return this._call('setWindowsState', vehicleConfig, options);
  }

  setChargingCurrent(vehicleConfig, level) {
    return this._call('setChargingCurrent', vehicleConfig, level);
  }

  setVehicleToLoadDischargeLimit(vehicleConfig, limit) {
    return this._call('setVehicleToLoadDischargeLimit', vehicleConfig, limit);
  }

  valetModeAction(vehicleConfig, action) {
    return this._call('valetModeAction', vehicleConfig, action);
  }

  drivingInfo(vehicleConfig) {
    return this._call('drivingInfo', vehicleConfig);
  }

  // Not wired into the Homey app yet — ported ahead of time, see ../NAMING.md.
  scheduleChargingAndClimate(vehicleConfig, options) {
    return this._call('scheduleChargingAndClimate', vehicleConfig, options);
  }

  // Not wired into the Homey app yet — ported ahead of time, see ../NAMING.md.
  tripInfo(vehicleConfig, dateString, period) {
    return this._call('tripInfo', vehicleConfig, dateString, period);
  }
}

module.exports = VehicleManager;
