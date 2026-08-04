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
// KNOWN LIMITATION (still to validate, no test account available): the
// server can return an OTP challenge on login (e.g. for a new device)
// instead of a session directly. That OTP flow exists in the Python source
// (send_otp/verify_otp_and_complete_login) but is NOT wired up here to a
// Homey pairing UI (that requires a separate pairing step in
// driver.js/pair.html that can't be built blind without an account that
// actually triggers OTP). login() throws a clear error in that case instead
// of crashing.
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
const { getChildValue } = require('../utils');
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
    this.BASE_URL = 'api.owners.kia.com';
    this.API_URL = `https://${this.BASE_URL}/apigw/v1/`;
    this.session = new ApiImplSession({ httpsAgent: KIA_USA_HTTPS_AGENT, logger: this.logger });
  }

  apiHeaders() {
    const offset = -(new Date().getTimezoneOffset()) / 60;
    const clientUuid = crypto.randomUUID();
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

  async login(username, password, pin) {
    const url = `${this.API_URL}prof/authUser`;
    const data = {
      deviceKey: this.deviceId, deviceType: 2, userCredential: { userId: username, password }, tncFlag: 1,
    };
    const headers = this.apiHeaders();
    const res = await this.session.postJson(url, data, { headers });
    const responseJson = await res.json();
    const sessionId = res.headers.get('sid');
    if (sessionId) {
      return new Token({
        username,
        password,
        pin,
        accessToken: sessionId,
        deviceId: this.deviceId,
        validUntil: new Date(Date.now() + 23 * 60 * 60 * 1000),
      });
    }
    if (responseJson.payload && responseJson.payload.otpKey) {
      throw new AuthenticationOTPRequired(
        'This Kia US account requires OTP verification on first login from a new device. '
        + 'OTP-pairing is not yet supported by this Homey app — see lib/connect/NAMING.md.',
      );
    }
    const status = responseJson.status || {};
    if (status.errorCode === 1001) {
      throw new AuthenticationError(`Invalid Email or Password: ${status.errorMessage || ''}`);
    }
    throw new APIError(`No session id returned in login. Response: ${JSON.stringify(responseJson)}`);
  }

  async refreshAccessToken(token) {
    return this.login(token.username, token.password, token.pin);
  }

  async getVehicles(token) {
    const url = `${this.API_URL}ownr/gvl`;
    const headers = { ...this.apiHeaders(), sid: token.accessToken };
    const response = await this.session.getJson(url, { headers });
    if (!response.payload) throw new APIError('Missing payload in response');
    return response.payload.vehicleSummary.map((entry) => ({
      ...entry,
      id: entry.vehicleIdentifier,
      key: entry.vehicleKey,
      name: entry.nickName,
      vin: entry.vin,
    }));
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
    const response = await this.session.postJsonExpectJson(url, body, { headers: this.authedApiHeaders(token, vehicleConfig) });
    return response.payload.vehicleInfoList[0];
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
      dte: { value: getChildValue(s, 'distanceToEmpty.value') },
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
    const odometer = { value: getChildValue(state, 'vehicleConfig.vehicleDetail.vehicle.mileage') };
    return { vehicleStatus, vehicleLocation, odometer };
  }

  async updateVehicleWithCachedState(token, vehicleConfig) {
    const state = await this._getCachedVehicleState(token, vehicleConfig);
    return KiaUvoApiUSA._normalizeStatus(state);
  }

  async forceRefreshVehicleState(token, vehicleConfig) {
    const url = `${this.API_URL}rems/rvs`;
    // requestType 0 forces a refresh (1 would return the cache).
    await this.session.postJsonExpectJson(url, { requestType: 0 }, { headers: this.authedApiHeaders(token, vehicleConfig) });
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
    const response = await this.session.get(url, { headers: this.authedApiHeaders(token, vehicleConfig) });
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
    const response = await this.session.postJson(url, body, { headers: this.authedApiHeaders(token, vehicleConfig) });
    await response.json();
    return response.headers.get('xid');
  }

  async stopClimate(token, vehicleConfig) {
    const url = `${this.API_URL}rems/stop`;
    const response = await this.session.get(url, { headers: this.authedApiHeaders(token, vehicleConfig) });
    return response.headers.get('xid');
  }

  async startCharge(token, vehicleConfig) {
    const url = `${this.API_URL}evc/charge`;
    const response = await this.session.postJson(url, { chargeRatio: 100 }, { headers: this.authedApiHeaders(token, vehicleConfig) });
    await response.json();
    return response.headers.get('xid');
  }

  async stopCharge(token, vehicleConfig) {
    const url = `${this.API_URL}evc/cancel`;
    const response = await this.session.get(url, { headers: this.authedApiHeaders(token, vehicleConfig) });
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
    const response = await this.session.postJson(url, body, { headers: this.authedApiHeaders(token, vehicleConfig) });
    await response.json();
    return response.headers.get('xid');
  }
}

module.exports = KiaUvoApiUSA;
