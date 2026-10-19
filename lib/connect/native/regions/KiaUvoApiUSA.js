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

// Port of KiaUvoApiUSA.py. A completely different backend than EU/AU/CN
// (owners.kia.com instead of the SPA/CCS2 API): session-based auth via a
// "sid" header (no OAuth bearer tokens), vehicles identified via "vinKey"
// instead of vehicleId, and a very different raw status shape
// (lastVehicleInfo.vehicleStatusRpt.*).
//
// OTP (upstream send_otp/verify_otp_and_complete_login): login() throws
// AuthenticationOTPRequired with the OTPRequest on `.otpRequest` instead of
// returning it. The rmtoken from a verified OTP only works together with the
// deviceId it was issued to, so both are persisted by the Homey device and
// handed back via restoreDeviceAuth() (deviation: upstream's caller persists
// the whole Token). Untested against a real OTP account.
//
// The raw status shape is translated here to the same flat
// { vehicleStatus, vehicleLocation, odometer } convention as the other
// regions (device.js#mapStatus() expects e.g. sts.airCtrlOn, sts.doorLock,
// not sts.climate.airCtrl / sts.doorStatus). This translation covers the
// fields mapStatus() actually reads; less common fields (dtc, sunroof, etc.)
// were not included. See ../../NAMING.md.

const crypto = require('crypto');
const https = require('https');
const { ApiImplSession } = require('../http');
const ApiImpl = require('../ApiImpl');
const Token = require('../Token');
const { VEHICLE_LOCK_ACTION } = require('../const');
const { getChildValue, uuid5 } = require('../utils');
const { APIError, AuthenticationError, AuthenticationOTPRequired } = require('../exceptions');
const { prefixLogger } = require('../logger');

// Kia USA's server requires (as documented in the Python source, see
// KiaSSLAdapter in KiaUvoApiUSA.py) a lowered TLS security level
// (SECLEVEL=1) for compatibility — otherwise a modern OpenSSL default
// rejects the handshake. Node/OpenSSL supports the same ciphers syntax as
// Python's urllib3. ApiImplSession routes through Node's built-in https
// module as soon as httpsAgent is set (fetch/undici doesn't accept a
// classic https.Agent) — see ../http.js.
// UNTESTED: no Kia USA account available to validate this against.
const KIA_USA_HTTPS_AGENT = new https.Agent({
  ciphers: 'DEFAULT:@SECLEVEL=1',
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
});

class KiaUvoApiUSA extends ApiImpl {
  constructor(region, brand, language, { logger } = {}) {
    super();
    this.logger = prefixLogger(logger, 'KiaUvoApiUSA');
    this.temperatureRange = Array.from({ length: 21 }, (_, i) => 62 + i); // 62..82
    this.deviceId = crypto.randomUUID().toUpperCase();
    this.rmToken = null;
    this.BASE_URL = 'api.owners.kia.com';
    this.API_URL = `https://${this.BASE_URL}/apigw/v1/`;
    this.session = new ApiImplSession({ httpsAgent: KIA_USA_HTTPS_AGENT, logger: this.logger });
  }

  apiHeaders() {
    const offset = -(new Date().getTimezoneOffset()) / 60;
    // Generate clientuuid as hash of device_id (similar to iOS app)
    const clientUuid = uuid5(this.deviceId);
    return {
      'content-type': 'application/json;charset=utf-8',
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'accept-charset': 'utf-8',
      apptype: 'L',
      appversion: '7.22.0',
      clientid: 'SPACL716-APL',
      clientuuid: clientUuid,
      from: 'SPA',
      host: this.BASE_URL,
      language: '0',
      offset: String(Math.trunc(offset)),
      ostype: 'iOS',
      osversion: '15.8.5',
      phonebrand: 'iPhone',
      secretkey: 'sydnat-9kykci-Kuhtep-h5nK',
      to: 'APIGW',
      tokentype: 'A',
      'user-agent': 'KIAPrimo_iOS/37 CFNetwork/1335.0.3.4 Darwin/21.6.0',
      date: new Date().toUTCString(),
      deviceid: this.deviceId,
    };
  }

  authedApiHeaders(token, vehicleConfig) {
    return { ...this.apiHeaders(), sid: token.accessToken, vinkey: vehicleConfig.key };
  }

  // Port of the request_with_logging decorator: the server reports errors in
  // a 200-OK body, so a non-zero statusCode must throw here — otherwise e.g.
  // an expired session ("Session Key is either invalid or expired") passes
  // silently as a successful command. Returns the parsed body (deviation:
  // upstream returns the Response and re-parses it in each caller).
  static async _requestWithLogging(response) {
    const responseJson = await response.json();
    // Type-guard (deviation): upstream would raise a KeyError/TypeError on a
    // body without a status dict, e.g. a gateway error page.
    let status = responseJson && responseJson.status;
    status = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
    if (status.statusCode === 0) return responseJson;
    if (
      status.statusCode === 1
      && status.errorType === 1
      && [1003, 1005].includes(status.errorCode)
    ) {
      throw new AuthenticationError('Session invalid');
    }
    throw new APIError(`Unknown error response: ${JSON.stringify(responseJson)}`);
  }

  // Port of the request_with_active_session decorator: on an invalid session,
  // log in again, refresh the (session-specific) vehicle key and resend once.
  // Updates token and vehicleConfig in place, like upstream.
  async _requestWithActiveSession(token, vehicleConfig, jsonBody, send) {
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof AuthenticationError)) throw error;
      this.logger.log('Got invalid session, attempting to repair and resend');
      const newToken = await this.login(token.username, token.password, token.pin);
      token.accessToken = newToken.accessToken;
      token.refreshToken = newToken.refreshToken;
      token.validUntil = newToken.validUntil;
      await this.refreshVehicles(token, vehicleConfig);
      if (jsonBody && jsonBody.vinKey) jsonBody.vinKey = [vehicleConfig.key];
      return send();
    }
  }

  // Returns { response, json } so callers can read the xid header.
  postRequestWithLoggingAndActiveSession(token, url, jsonBody, vehicleConfig) {
    return this._requestWithActiveSession(token, vehicleConfig, jsonBody, async () => {
      const response = await this.session.postJson(url, jsonBody, { headers: this.authedApiHeaders(token, vehicleConfig) });
      const json = await KiaUvoApiUSA._requestWithLogging(response);
      return { response, json };
    });
  }

  getRequestWithLoggingAndActiveSession(token, url, vehicleConfig) {
    return this._requestWithActiveSession(token, vehicleConfig, null, async () => {
      const response = await this.session.get(url, { headers: this.authedApiHeaders(token, vehicleConfig) });
      const json = await KiaUvoApiUSA._requestWithLogging(response);
      return { response, json };
    });
  }

  async login(username, password, pin) {
    const url = `${this.API_URL}prof/authUser`;
    const data = {
      deviceKey: this.deviceId, deviceType: 2, userCredential: { userId: username, password }, tncFlag: 1,
    };
    const headers = this.apiHeaders();
    if (this.rmToken) headers.rmtoken = this.rmToken;
    const res = await this.session.postJson(url, data, { headers });
    const responseJson = await res.json();
    const sessionId = res.headers.get('sid');
    if (sessionId) {
      return new Token({
        username,
        password,
        pin,
        accessToken: sessionId,
        refreshToken: this.rmToken,
        deviceId: this.deviceId,
        validUntil: new Date(Date.now() + 23 * 60 * 60 * 1000),
      });
    }
    if (responseJson.payload && responseJson.payload.otpKey) {
      const { payload } = responseJson;
      if (payload.rmTokenExpired) this.logger.log('Stored rmtoken has expired, need new OTP');
      const error = new AuthenticationOTPRequired('OTP verification required for this Kia US account.');
      error.otpRequest = {
        otpKey: payload.otpKey,
        requestId: res.headers.get('xid') || '',
        email: payload.email,
        sms: payload.phone,
        hasEmail: !!payload.hasEmail,
        hasSms: !!payload.hasPhone,
      };
      throw error;
    }
    // Type-guard, not `|| {}`: a non-dict status (upstream #1324) must not
    // break the error branch below.
    let { status } = responseJson;
    status = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
    if (status.errorCode === 1001) {
      throw new AuthenticationError(`Invalid Email or Password: ${status.errorMessage || ''}`);
    }
    throw new APIError(`No session id returned in login. Response: ${JSON.stringify(responseJson)}`);
  }

  async refreshAccessToken(token) {
    if (token.deviceId) this.deviceId = token.deviceId;
    if (token.refreshToken) this.rmToken = token.refreshToken;
    return this.login(token.username, token.password, token.pin);
  }

  // Not upstream: seeds the persisted deviceId + rmtoken after an app restart.
  restoreDeviceAuth({ deviceId, refreshToken } = {}) {
    if (deviceId) this.deviceId = deviceId;
    if (refreshToken) this.rmToken = refreshToken;
  }

  getDeviceAuth() {
    return { deviceId: this.deviceId, refreshToken: this.rmToken };
  }

  async _sendOtp(otpKey, notifyType, xid) {
    const url = `${this.API_URL}cmm/sendOTP`;
    const headers = this.apiHeaders();
    headers.otpkey = otpKey;
    headers.notifytype = notifyType;
    headers.xid = xid;
    const res = await this.session.postJson(url, {}, { headers });
    return res.json();
  }

  async _verifyOtp(otpKey, otpCode, xid) {
    const url = `${this.API_URL}cmm/verifyOTP`;
    const headers = this.apiHeaders();
    headers.otpkey = otpKey;
    headers.xid = xid;
    const res = await this.session.postJson(url, { otp: otpCode }, { headers });
    const responseJson = await res.json();
    let { status } = responseJson;
    status = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
    if (status.statusCode) {
      throw new AuthenticationError(`OTP verification failed: ${status.errorMessage || ''}`);
    }
    const sid = res.headers.get('sid');
    const rmtoken = res.headers.get('rmtoken');
    if (!sid || !rmtoken) {
      throw new APIError('No sid or rmtoken in OTP verification response.');
    }
    return [sid, rmtoken];
  }

  async _completeLoginWithOtp(username, password, sid, rmtoken) {
    const url = `${this.API_URL}prof/authUser`;
    const data = {
      deviceKey: this.deviceId,
      deviceType: 2,
      userCredential: { userId: username, password },
    };
    const headers = this.apiHeaders();
    headers.sid = sid;
    headers.rmtoken = rmtoken;
    const res = await this.session.postJson(url, data, { headers });
    const responseText = await res.text();
    const finalSid = res.headers.get('sid');
    if (!finalSid) {
      throw new APIError(`No final sid returned. Response: ${responseText}`);
    }
    return finalSid;
  }

  async sendOtp(otpRequest, notifyType) {
    return this._sendOtp(otpRequest.otpKey, notifyType, otpRequest.requestId);
  }

  async verifyOtpAndCompleteLogin(username, password, otpCode, otpRequest, pin) {
    const [sid, rmtoken] = await this._verifyOtp(otpRequest.otpKey, otpCode, otpRequest.requestId);
    const finalSid = await this._completeLoginWithOtp(username, password, sid, rmtoken);
    this.logger.log('OTP Successful, obtained final session id');
    this.rmToken = rmtoken;
    return new Token({
      username,
      password,
      pin,
      accessToken: finalSid,
      refreshToken: rmtoken,
      deviceId: this.deviceId,
      validUntil: new Date(Date.now() + 23 * 60 * 60 * 1000),
    });
  }

  // Port of the _retry_on_auth_error decorator, for getVehicles/refreshVehicles.
  async _retryOnAuthError(token, func) {
    try {
      return await func();
    } catch (error) {
      if (!(error instanceof AuthenticationError)) throw error;
      this.logger.log('Session expired, re-logging in');
      let newToken;
      try {
        newToken = await this.login(token.username, token.password, token.pin);
      } catch (e) {
        if (e instanceof AuthenticationOTPRequired) throw e;
        throw new AuthenticationError(`Re-login failed: ${e.message}`, { cause: e });
      }
      token.accessToken = newToken.accessToken;
      token.refreshToken = newToken.refreshToken;
      token.validUntil = newToken.validUntil;
      return func();
    }
  }

  static _checkGvlResponse(response) {
    let { status } = response;
    status = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
    if (status.statusCode === 1 && status.errorType === 1 && [1003, 1005].includes(status.errorCode)) {
      throw new AuthenticationError('Session invalid');
    }
    if (!response.payload) throw new APIError('Missing payload in response');
  }

  async getVehicles(token) {
    return this._retryOnAuthError(token, () => this._getVehicles(token));
  }

  async _getVehicles(token) {
    const url = `${this.API_URL}ownr/gvl`;
    const headers = { ...this.apiHeaders(), sid: token.accessToken };
    const response = await this.session.getJson(url, { headers });
    KiaUvoApiUSA._checkGvlResponse(response);
    return response.payload.vehicleSummary.map((entry) => ({
      ...entry,
      id: entry.vehicleIdentifier,
      key: entry.vehicleKey,
      name: entry.nickName,
      vin: entry.vin,
    }));
  }

  // Port of refresh_vehicles (single-vehicle branch): the vehicle key is
  // session specific, so it must be re-read after every new login.
  async refreshVehicles(token, vehicleConfig) {
    return this._retryOnAuthError(token, async () => {
      const url = `${this.API_URL}ownr/gvl`;
      const headers = { ...this.apiHeaders(), sid: token.accessToken };
      const response = await this.session.getJson(url, { headers });
      KiaUvoApiUSA._checkGvlResponse(response);
      for (const entry of response.payload.vehicleSummary) {
        if (vehicleConfig.id === entry.vehicleIdentifier) {
          vehicleConfig.name = entry.nickName;
          vehicleConfig.key = entry.vehicleKey;
          vehicleConfig.vehicleKey = entry.vehicleKey;
        }
      }
    });
  }

  async _getCachedVehicleState(token, vehicleConfig) {
    const url = `${this.API_URL}cmm/gvi`;
    const body = {
      vehicleConfigReq: {
        airTempRange: '0', maintenance: '1', seatHeatCoolOption: '0', vehicle: '1', vehicleFeature: '0',
      },
      vehicleInfoReq: {
        drivingActivty: '0', dtc: '1', enrollment: '1', functionalCards: '0', location: '1', vehicleStatus: '1', weather: '0',
      },
      vinKey: [vehicleConfig.key],
    };
    const { json } = await this.postRequestWithLoggingAndActiveSession(token, url, body, vehicleConfig);
    return json.payload.vehicleInfoList[0];
  }

  // Translates the deeply-nested USA status into the same flat shape as the
  // other regions, so device.js#mapStatus() can read it. Best-effort: covers
  // the fields mapStatus() uses, not the full Python parsing.
  static _normalizeStatus(state) {
    const s = getChildValue(state, 'lastVehicleInfo.vehicleStatusRpt.vehicleStatus') || {};
    const ev = s.evStatus || {};
    const vehicleStatus = {
      time: getChildValue(state, 'lastVehicleInfo.vehicleStatusRpt.vehicleStatus.syncDate.utc'),
      airCtrlOn: getChildValue(s, 'climate.airCtrl'),
      airTemp: { value: getChildValue(s, 'climate.airTemp.value') },
      defrost: getChildValue(s, 'climate.defrost'),
      doorLock: s.doorLock,
      trunkOpen: getChildValue(s, 'doorStatus.trunk'),
      hoodOpen: getChildValue(s, 'doorStatus.hood'),
      doorOpen: {
        frontLeft: getChildValue(s, 'doorStatus.frontLeft'),
        frontRight: getChildValue(s, 'doorStatus.frontRight'),
        backLeft: getChildValue(s, 'doorStatus.backLeft'),
        backRight: getChildValue(s, 'doorStatus.backRight'),
      },
      engine: s.engine,
      tirePressureLamp: { tirePressureLampAll: getChildValue(s, 'tirePressure.all') },
      battery: { batSoc: getChildValue(s, 'batteryStatus.stateOfCharge') },
      dte: { value: getChildValue(s, 'distanceToEmpty.value'), unit: getChildValue(s, 'distanceToEmpty.unit') },
      fuelLevel: s.fuelLevel,
      lowFuelLight: s.lowFuelLight,
      evStatus: {
        batteryStatus: ev.batteryStatus,
        batteryCharge: ev.batteryCharge,
        batteryPlugin: ev.batteryPlugin,
        drvDistance: [{
          rangeByFuel: {
            totalAvailableRange: getChildValue(ev, 'drvDistance.0.rangeByFuel.totalAvailableRange'),
            gasModeRange: getChildValue(ev, 'drvDistance.0.rangeByFuel.gasModeRange'),
          },
        }],
        reservChargeInfos: { targetSOClist: ev.targetSOC },
      },
    };
    const location = getChildValue(state, 'lastVehicleInfo.location');
    const vehicleLocation = location ? { coord: location.coord } : undefined;
    // mileage arrives as a string ("2161"); measure_odo needs a number. It
    // carries no unit field: upstream hardcodes miles (DISTANCE_UNITS[3]).
    const mileage = getChildValue(state, 'vehicleConfig.vehicleDetail.vehicle.mileage');
    const odometer = { value: mileage == null || mileage === '' ? undefined : Number(mileage), unit: 3 };
    return { vehicleStatus, vehicleLocation, odometer };
  }

  async updateVehicleWithCachedState(token, vehicleConfig) {
    const state = await this._getCachedVehicleState(token, vehicleConfig);
    return KiaUvoApiUSA._normalizeStatus(state);
  }

  async forceRefreshVehicleState(token, vehicleConfig) {
    const url = `${this.API_URL}rems/rvs`;
    // requestType 0 forces a refresh (1 would return the cache).
    await this.postRequestWithLoggingAndActiveSession(token, url, { requestType: 0 }, vehicleConfig);
    // Like upstream: the rvs response itself isn't directly usable for the
    // full status, so re-fetch the cached state after the force refresh.
    return this.updateVehicleWithCachedState(token, vehicleConfig);
  }

  async odometer(token, vehicleConfig) {
    const { odometer } = await this.updateVehicleWithCachedState(token, vehicleConfig);
    return odometer;
  }

  async lockAction(token, vehicleConfig, action) {
    const url = action === VEHICLE_LOCK_ACTION.LOCK ? `${this.API_URL}rems/door/lock` : `${this.API_URL}rems/door/unlock`;
    const { response } = await this.getRequestWithLoggingAndActiveSession(token, url, vehicleConfig);
    return response.headers.get('xid');
  }

  _seatSettings(level) {
    const levels = {
      8: { heatVentType: 1, heatVentLevel: 4, heatVentStep: 1 },
      7: { heatVentType: 1, heatVentLevel: 3, heatVentStep: 2 },
      6: { heatVentType: 1, heatVentLevel: 2, heatVentStep: 3 },
      5: { heatVentType: 2, heatVentLevel: 4, heatVentStep: 1 },
      4: { heatVentType: 2, heatVentLevel: 3, heatVentStep: 2 },
      3: { heatVentType: 2, heatVentLevel: 2, heatVentStep: 3 },
      1: { heatVentType: 1, heatVentLevel: 4, heatVentStep: 1 },
    };
    return levels[level] || { heatVentType: 0, heatVentLevel: 1, heatVentStep: 0 };
  }

  async startClimate(token, vehicleConfig, options = {}) {
    const url = `${this.API_URL}rems/start`;
    let setTemp = options.setTemp ?? 70;
    if (setTemp < 62) setTemp = 'LOW';
    else if (setTemp > 82) setTemp = 'HIGH';
    const climate = options.climate ?? true;
    const heating = options.heating ?? 0;
    const defrost = options.defrost ?? false;
    const duration = options.duration ?? 5;
    const steeringWheel = options.steeringWheel ?? 0;

    const body = {
      remoteClimate: {
        airTemp: { unit: 1, value: String(setTemp) },
        airCtrl: climate,
        defrost,
        heatingAccessory: {
          rearWindow: [1, 2, 4].includes(heating) ? 1 : 0,
          sideMirror: [1, 4].includes(heating) ? 1 : 0,
          steeringWheel: [1, 2].includes(steeringWheel) ? 1 : 0,
          steeringWheelStep: steeringWheel,
        },
        ignitionOnDuration: { unit: 4, value: duration },
      },
    };
    if ([options.frontLeftSeat, options.frontRightSeat, options.rearLeftSeat, options.rearRightSeat].some((v) => v !== undefined)) {
      body.remoteClimate.heatVentSeat = {
        driverSeat: this._seatSettings(options.frontLeftSeat),
        passengerSeat: this._seatSettings(options.frontRightSeat),
        rearLeftSeat: this._seatSettings(options.rearLeftSeat),
        rearRightSeat: this._seatSettings(options.rearRightSeat),
      };
    }
    const { response } = await this.postRequestWithLoggingAndActiveSession(token, url, body, vehicleConfig);
    return response.headers.get('xid');
  }

  async stopClimate(token, vehicleConfig) {
    const url = `${this.API_URL}rems/stop`;
    const { response } = await this.getRequestWithLoggingAndActiveSession(token, url, vehicleConfig);
    return response.headers.get('xid');
  }

  async startCharge(token, vehicleConfig) {
    const url = `${this.API_URL}evc/charge`;
    const { response } = await this.postRequestWithLoggingAndActiveSession(token, url, { chargeRatio: 100 }, vehicleConfig);
    return response.headers.get('xid');
  }

  async stopCharge(token, vehicleConfig) {
    const url = `${this.API_URL}evc/cancel`;
    const { response } = await this.getRequestWithLoggingAndActiveSession(token, url, vehicleConfig);
    return response.headers.get('xid');
  }

  async setChargeLimits(token, vehicleConfig, ac, dc) {
    const url = `${this.API_URL}evc/sts`;
    const body = {
      targetSOClist: [
        { plugType: 0, targetSOClevel: Number(dc) },
        { plugType: 1, targetSOClevel: Number(ac) },
      ],
    };
    const { response } = await this.postRequestWithLoggingAndActiveSession(token, url, body, vehicleConfig);
    return response.headers.get('xid');
  }
}

module.exports = KiaUvoApiUSA;
