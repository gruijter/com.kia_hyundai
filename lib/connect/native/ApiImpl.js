'use strict';

// Port of ApiImpl.py: the abstract interface each region implementation
// fills in. Method names are the camelCase form of the Python snake_case
// names — see ../NAMING.md. Non-overridden methods throw "not implemented",
// exactly like upstream.
class ApiImpl {
  notImplemented(name) {
    throw new Error(`${name} is not implemented for this region`);
  }

  // eslint-disable-next-line no-unused-vars
  async login(username, password, pin) {
    this.notImplemented('login');
  }

  // eslint-disable-next-line no-unused-vars
  async sendOtp(otpRequest, notifyType) {
    this.notImplemented('sendOtp');
  }

  // eslint-disable-next-line no-unused-vars
  async verifyOtpAndCompleteLogin(username, password, otpCode, otpRequest, pin) {
    this.notImplemented('verifyOtpAndCompleteLogin');
  }

  // eslint-disable-next-line no-unused-vars
  async getVehicles(token) {
    this.notImplemented('getVehicles'); return [];
  }

  // optional, default no-op
  // eslint-disable-next-line no-unused-vars, no-empty-function
  async refreshVehicles(token, vehicles) {}

  // Deliberately deviates from upstream: returns the raw status JSON from
  // the cloud instead of mutating a Vehicle dataclass (see ../NAMING.md).
  // eslint-disable-next-line no-unused-vars
  async updateVehicleWithCachedState(token, vehicleConfig) {
    this.notImplemented('updateVehicleWithCachedState');
  }

  // eslint-disable-next-line no-unused-vars
  async forceRefreshVehicleState(token, vehicleConfig) {
    this.notImplemented('forceRefreshVehicleState');
  }

  async testToken() {
    return true;
  }

  // eslint-disable-next-line no-unused-vars
  async checkActionStatus(token, vehicleConfig, actionId, synchronous = false, timeout = 0) {
    return undefined;
  }

  // eslint-disable-next-line no-unused-vars
  async lockAction(token, vehicleConfig, action) {
    this.notImplemented('lockAction');
  }

  // eslint-disable-next-line no-unused-vars
  async startClimate(token, vehicleConfig, options) {
    this.notImplemented('startClimate');
  }

  // eslint-disable-next-line no-unused-vars
  async stopClimate(token, vehicleConfig) {
    this.notImplemented('stopClimate');
  }

  // eslint-disable-next-line no-unused-vars
  async startCharge(token, vehicleConfig) {
    this.notImplemented('startCharge');
  }

  // eslint-disable-next-line no-unused-vars
  async stopCharge(token, vehicleConfig) {
    this.notImplemented('stopCharge');
  }

  // eslint-disable-next-line no-unused-vars
  async setChargeLimits(token, vehicleConfig, ac, dc) {
    this.notImplemented('setChargeLimits');
  }

  // eslint-disable-next-line no-unused-vars
  async setChargingCurrent(token, vehicleConfig, level) {
    this.notImplemented('setChargingCurrent');
  }

  // eslint-disable-next-line no-unused-vars
  async setWindowsState(token, vehicleConfig, options) {
    this.notImplemented('setWindowsState');
  }

  // eslint-disable-next-line no-unused-vars
  async chargePortAction(token, vehicleConfig, action) {
    this.notImplemented('chargePortAction');
  }

  // eslint-disable-next-line no-unused-vars
  async startHazardLights(token, vehicleConfig) {
    this.notImplemented('startHazardLights');
  }

  // eslint-disable-next-line no-unused-vars
  async startHazardLightsAndHorn(token, vehicleConfig) {
    this.notImplemented('startHazardLightsAndHorn');
  }

  // eslint-disable-next-line no-unused-vars
  async valetModeAction(token, vehicleConfig, action) {
    this.notImplemented('valetModeAction');
  }

  // eslint-disable-next-line no-unused-vars
  async setVehicleToLoadDischargeLimit(token, vehicleConfig, limit) {
    this.notImplemented('setVehicleToLoadDischargeLimit');
  }

  // eslint-disable-next-line no-unused-vars
  async setNavigation(token, vehicleConfig, poiList) {
    this.notImplemented('setNavigation');
  }

  // Default: just log in again. Regions with a real refresh_token flow
  // (e.g. EU) override this.
  async refreshAccessToken(token) {
    return this.login(token.username, token.password, token.pin);
  }
}

module.exports = ApiImpl;
