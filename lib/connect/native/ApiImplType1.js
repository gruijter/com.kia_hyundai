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

const { promisify } = require('util');
const ApiImpl = require('./ApiImpl');
const { ApiImplSession, USER_AGENT_OK_HTTP } = require('./http');
const { VEHICLE_LOCK_ACTION, ORDER_STATUS } = require('./const');
const { getIndexIntoHexTemp, formatScheduleTime } = require('./utils');

const wait = promisify(setTimeout);
const {
  APIError, DeviceIDError, DuplicateRequestError, UnsupportedControlError,
  RequestTimeoutError, ServiceTemporaryUnavailable, RateLimitingError,
  NoDataFound, AuthenticationError, InvalidAPIResponseError,
} = require('./exceptions');

const ERROR_CODE_MAPPING = {
  7501: AuthenticationError,
  4002: DeviceIDError,
  4004: DuplicateRequestError,
  4005: UnsupportedControlError,
  4081: RequestTimeoutError,
  5031: ServiceTemporaryUnavailable,
  5091: RateLimitingError,
  5921: NoDataFound,
  9999: RequestTimeoutError,
};

// Port of ApiImplType1.py#_check_response_for_errors.
function checkResponseForErrors(response) {
  const hasKnownField = ['retCode', 'resCode', 'resMsg', 'error', 'access_token']
    .some((k) => Object.prototype.hasOwnProperty.call(response, k));
  if (!hasKnownField) throw new InvalidAPIResponseError(`Unknown API response format: ${JSON.stringify(response)}`);

  if (response.retCode === 'F') {
    const ErrorClass = ERROR_CODE_MAPPING[response.resCode];
    if (ErrorClass) throw new ErrorClass(response.resMsg);
    throw new APIError(`Server returned: '${response.resCode}' '${response.resMsg}'`);
  }
  if (response.error) throw new AuthenticationError(response.error);
  if (response.retCode && response.retMsg === 'Received unexpected statusCode') {
    throw new AuthenticationError(response.retMsg);
  }
}

// Port of ApiImplType1.py#_retry_on_device_id_error: on a DeviceIDError, the
// EU server sometimes deregisters the device_id (e.g. after a failed push
// delivery); this re-registers the device_id and retries once.
function retryOnDeviceIdError(fn) {
  return async function wrapped(token, ...args) {
    try {
      return await fn.call(this, token, ...args);
    } catch (error) {
      if (!(error instanceof DeviceIDError)) throw error;
      const stamp = this._getStamp();
      // eslint-disable-next-line no-param-reassign
      token.deviceId = await this._getDeviceId(stamp);
      return fn.call(this, token, ...args);
    }
  };
}

// Port of ApiImplType1.py: shared control logic for the "Type 1" family of
// regions (EU and relatives). Subclasses set the brand/region-specific
// constants (SPA_API_URL, CCSP_SERVICE_ID, APP_ID, ...) in their constructor.
class ApiImplType1 extends ApiImpl {
  constructor() {
    super();
    this.session = new ApiImplSession();
    [
      'getVehicles', 'stopCharge', 'setChargingCurrent', 'setChargeLimits',
      'setVehicleToLoadDischargeLimit', 'lockAction', 'checkActionStatus',
      'startClimate', 'stopClimate', 'startHazardLights', 'startHazardLightsAndHorn',
      'setWindowsState', 'setNavigation',
    ].forEach((name) => {
      this[name] = retryOnDeviceIdError(this[name]).bind(this);
    });
  }

  _getAuthenticatedHeaders(token, ccs2Support = 0) {
    return {
      Authorization: token.accessToken,
      'ccsp-service-id': this.CCSP_SERVICE_ID,
      'ccsp-application-id': this.APP_ID,
      Stamp: this._getStamp(),
      'ccsp-device-id': token.deviceId,
      Host: this.BASE_URL,
      Connection: 'Keep-Alive',
      'Accept-Encoding': 'gzip',
      Ccuccs2protocolsupport: String(ccs2Support || 0),
      'User-Agent': USER_AGENT_OK_HTTP,
    };
  }

  async _getControlToken(token) {
    if (token.controlToken && token.controlTokenExpiry > Date.now() / 1000) {
      return token.controlToken;
    }
    const url = `${this.USER_API_URL}pin?token=`;
    const response = await this.session.putJsonExpectJson(url, {
      deviceId: token.deviceId,
      pin: token.pin,
    }, {
      headers: {
        Authorization: token.accessToken,
        Host: this.BASE_URL,
        'Accept-Encoding': 'gzip',
      },
    });
    if (!response.controlToken) {
      throw new APIError('PIN verification failed, ensure PIN is entered correctly.');
    }
    token.controlToken = `Bearer ${response.controlToken}`;
    token.controlTokenExpiry = Math.floor(Date.now() / 1000 + response.expiresTime);
    return token.controlToken;
  }

  async _getControlHeaders(token, vehicleConfig) {
    const controlToken = await this._getControlToken(token);
    const headers = this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport);
    return { ...headers, Authorization: controlToken, AuthorizationCCSP: controlToken };
  }

  // Port of get_vehicles: returns the raw vehicle-list entries (with a few
  // aliases for bluelinky-like field names), not a Vehicle dataclass — see
  // ../NAMING.md.
  async getVehicles(token) {
    const url = `${this.SPA_API_URL}vehicles`;
    const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    return response.resMsg.vehicles.map((entry) => ({
      ...entry,
      id: entry.vehicleId,
      name: entry.vehicleName,
    }));
  }

  async startCharge(token, vehicleConfig) {
    let url;
    let payload;
    let headers;
    if (!vehicleConfig.ccuCCS2ProtocolSupport) {
      url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/control/charge`;
      payload = { action: 'start', deviceId: token.deviceId };
      headers = this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport);
    } else {
      url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/ccs2/control/charge`;
      payload = { command: 'start' };
      headers = await this._getControlHeaders(token, vehicleConfig);
    }
    const response = await this.session.postJsonExpectJson(url, payload, { headers });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async stopCharge(token, vehicleConfig) {
    let url;
    let payload;
    let headers;
    if (!vehicleConfig.ccuCCS2ProtocolSupport) {
      url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/control/charge`;
      payload = { action: 'stop', deviceId: token.deviceId };
      headers = this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport);
    } else {
      url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/ccs2/control/charge`;
      payload = { command: 'stop' };
      headers = await this._getControlHeaders(token, vehicleConfig);
    }
    const response = await this.session.postJsonExpectJson(url, payload, { headers });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async setChargingCurrent(token, vehicleConfig, level) {
    if (!vehicleConfig.ccuCCS2ProtocolSupport) {
      throw new UnsupportedControlError('setChargingCurrent requires CCS2 protocol support');
    }
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/ccs2/charge/chargingcurrent`;
    const response = await this.session.postJsonExpectJson(url, { chargingCurrent: level }, {
      headers: this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  // ac = slow (Type2/AC) target limit, dc = fast (DC) target limit — see ../NAMING.md.
  async setChargeLimits(token, vehicleConfig, ac, dc) {
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/charge/target`;
    const body = {
      targetSOClist: [
        { plugType: 0, targetSOClevel: Number(dc) },
        { plugType: 1, targetSOClevel: Number(ac) },
      ],
    };
    const response = await this.session.postJsonExpectJson(url, body, {
      headers: this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async setVehicleToLoadDischargeLimit(token, vehicleConfig, limit) {
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/ccs2/charge/dischargelimit`;
    const response = await this.session.postJsonExpectJson(url, { dischargingLimit: Number(limit) }, {
      headers: this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async lockAction(token, vehicleConfig, action) {
    let url;
    let payload;
    let headers;
    if (!vehicleConfig.ccuCCS2ProtocolSupport) {
      url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/control/door`;
      payload = { action: action === VEHICLE_LOCK_ACTION.LOCK ? 'close' : 'open', deviceId: token.deviceId };
      headers = this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport);
    } else {
      url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/ccs2/control/door`;
      payload = { command: action === VEHICLE_LOCK_ACTION.LOCK ? 'close' : 'open' };
      headers = await this._getControlHeaders(token, vehicleConfig);
    }
    const response = await this.session.postJsonExpectJson(url, payload, { headers });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async checkActionStatus(token, vehicleConfig, actionId, synchronous = false, timeout = 0) {
    if (synchronous) {
      if (timeout < 1) throw new APIError('Timeout must be 1 or higher');
      const endTime = Date.now() + timeout * 1000;
      while (Date.now() < endTime) {
        // eslint-disable-next-line no-await-in-loop
        const state = await this.checkActionStatus(token, vehicleConfig, actionId, false);
        if (state !== ORDER_STATUS.PENDING) return state;
        // eslint-disable-next-line no-await-in-loop
        await wait(5000);
      }
      return ORDER_STATUS.TIMEOUT;
    }
    const url = `${this.SPA_API_URL}notifications/${vehicleConfig.id}/records`;
    const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport) });
    checkResponseForErrors(response);
    const action = response.resMsg.find((a) => a.recordId === actionId);
    if (!action) return ORDER_STATUS.UNKNOWN;
    if (action.result === 'success') return ORDER_STATUS.SUCCESS;
    if (action.result === 'fail') return ORDER_STATUS.FAILED;
    if (action.result === 'non-response') return ORDER_STATUS.TIMEOUT;
    return ORDER_STATUS.PENDING;
  }

  _getDrvSeatLoc(vehicleConfig) {
    // EU/CN: km markets are LHD. AU/IN override this with "R".
    return vehicleConfig.odometerUnit === 'mi' ? 'R' : 'L';
  }

  async startClimate(token, vehicleConfig, options = {}) {
    const setTemp = options.setTemp ?? 21;
    const duration = options.duration ?? 5;
    const defrost = options.defrost ?? false;
    const heating = options.heating ?? 0;
    let url;
    let payload;
    let headers;
    if (!vehicleConfig.ccuCCS2ProtocolSupport) {
      url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/control/temperature`;
      const hexSetTemp = getIndexIntoHexTemp(this.temperatureRange.indexOf(setTemp));
      payload = {
        action: 'start',
        hvacType: 0,
        options: { defrost, heating1: Number(heating), igniOnDuration: duration },
        tempCode: hexSetTemp,
        unit: 'C',
      };
      headers = this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport);
    } else {
      url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/ccs2/control/temperature`;
      const drvSeatLoc = this._getDrvSeatLoc(vehicleConfig);
      const [drvSeat, psgSeat] = drvSeatLoc === 'R'
        ? [options.frontRightSeat, options.frontLeftSeat]
        : [options.frontLeftSeat, options.frontRightSeat];
      payload = {
        command: 'start',
        ignitionDuration: duration,
        strgWhlHeating: options.steeringWheel,
        hvacTempType: 1,
        hvacTemp: setTemp,
        sideRearMirrorHeating: [1, 2, 4].includes(heating) ? 1 : 0,
        drvSeatLoc,
        seatClimateInfo: {
          drvSeatClimateState: drvSeat,
          psgSeatClimateState: psgSeat,
          rrSeatClimateState: options.rearRightSeat,
          rlSeatClimateState: options.rearLeftSeat,
        },
        tempUnit: 'C',
        windshieldFrontDefogState: defrost,
      };
      headers = await this._getControlHeaders(token, vehicleConfig);
    }
    const response = await this.session.postJsonExpectJson(url, payload, { headers });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async stopClimate(token, vehicleConfig) {
    let url;
    let payload;
    let headers;
    if (!vehicleConfig.ccuCCS2ProtocolSupport) {
      url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/control/temperature`;
      payload = {
        action: 'stop', hvacType: 0, options: { defrost: true, heating1: 1 }, tempCode: '10H', unit: 'C',
      };
      headers = this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport);
    } else {
      url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/ccs2/control/temperature`;
      payload = { command: 'stop' };
      headers = await this._getControlHeaders(token, vehicleConfig);
    }
    const response = await this.session.postJsonExpectJson(url, payload, { headers });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async startHazardLights(token, vehicleConfig) {
    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/ccs2/control/light`;
    const response = await this.session.postJsonExpectJson(url, { command: 'on' }, {
      headers: await this._getControlHeaders(token, vehicleConfig),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async startHazardLightsAndHorn(token, vehicleConfig) {
    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/ccs2/control/hornlight`;
    const response = await this.session.postJsonExpectJson(url, { command: 'on' }, {
      headers: await this._getControlHeaders(token, vehicleConfig),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async setWindowsState(token, vehicleConfig, options) {
    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/control/windowcurtain`;
    const payload = {
      backLeft: options.backLeft,
      backRight: options.backRight,
      frontLeft: options.frontLeft,
      frontRight: options.frontRight,
    };
    const response = await this.session.postJsonExpectJson(url, payload, {
      headers: await this._getControlHeaders(token, vehicleConfig),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  // poiList: array of raw POI objects (device.js already builds these in the
  // shape the server expects — see ../NAMING.md).
  async setNavigation(token, vehicleConfig, poiList) {
    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/location/routes`;
    const payload = { deviceID: token.deviceId, poiInfoList: poiList };
    const response = await this.session.postJsonExpectJson(url, payload, {
      headers: await this._getControlHeaders(token, vehicleConfig),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  // Port of schedule_charging_and_climate. Not wired into the Homey app yet
  // (no capability/flow card) — ported ahead of time so it's ready when one
  // is added. options (all optional, upstream defaults filled in below —
  // see ScheduleChargingClimateRequestOptions in ApiImpl.py):
  //   firstDeparture / secondDeparture: { enabled, days: [0-6, Sun=0],
  //     time: 'HH:MM' } — default { enabled: false, days: [0], time: '00:00' }
  //   chargingEnabled: bool, default false
  //   offPeakStartTime / offPeakEndTime: 'HH:MM', default '00:00' / offPeakStartTime
  //   offPeakChargeOnlyEnabled: bool, default false
  //   climateEnabled: bool, default false
  //   temperature: number (°C unless temperatureUnit=1), default 21
  //   temperatureUnit: 0=C, 1=F, default 0
  //   defrost: bool, default false
  // Deviation from upstream: `time` fields are a 24-hour 'HH:MM' string
  // instead of a dt.time object — see utils.js#formatScheduleTime.
  async scheduleChargingAndClimate(token, vehicleConfig, options = {}) {
    const defaultDeparture = { enabled: false, days: [0], time: '00:00' };
    const firstDeparture = { ...defaultDeparture, ...options.firstDeparture };
    const secondDeparture = { ...defaultDeparture, ...options.secondDeparture };
    const departures = [firstDeparture, secondDeparture];

    const chargingEnabled = options.chargingEnabled ?? false;
    const offPeakStartTime = options.offPeakStartTime ?? '00:00';
    const offPeakEndTime = options.offPeakEndTime ?? offPeakStartTime;
    const offPeakChargeOnlyEnabled = options.offPeakChargeOnlyEnabled ?? false;
    const climateEnabled = options.climateEnabled ?? false;
    const temperatureUnit = options.temperatureUnit ?? 0;
    let temperature = options.temperature ?? 21.0;
    const defrost = options.defrost ?? false;

    // ccNC/EV5-appMode EVs (EV6/EV9) use two flat endpoints instead of the
    // combined /ccs2/reservation/chargehvac, which is a no-op for them.
    // vehicleConfig.type comes straight from getVehicles() ('EV'/'PHEV'/...,
    // see ApiImplType1.py#get_vehicles' entry["type"] mapping to ENGINE_TYPES).
    if (vehicleConfig.ccuCCS2ProtocolSupport && vehicleConfig.type === 'EV') {
      return this._scheduleEv5Flat(token, vehicleConfig, {
        firstDeparture,
        secondDeparture,
        chargingEnabled,
        offPeakStartTime,
        offPeakEndTime,
        offPeakChargeOnlyEnabled,
        climateEnabled,
        temperature,
        temperatureUnit,
        defrost,
      });
    }

    if (temperatureUnit === 0) {
      // Round to nearest 0.5, clamp to [17, 27] — matches upstream.
      temperature = Math.round(temperature * 2) / 2;
      if (temperature > 27) temperature = 27;
      else if (temperature < 17) temperature = 17;
    }

    const payload = {};
    departures.forEach((departure, i) => {
      payload[`reservChargeInfo${i + 1}`] = {
        reservChargeSet: departure.enabled,
        reservInfo: {
          day: departure.days,
          time: formatScheduleTime(departure.time),
        },
        reservFatcSet: {
          airCtrl: climateEnabled ? 1 : 0,
          airTemp: { value: temperature.toFixed(1), hvacTempType: 1, unit: temperatureUnit },
          heating1: 0,
          defrost,
        },
      };
    });
    payload.offPeakPowerInfo = {
      offPeakPowerTime1: {
        starttime: formatScheduleTime(offPeakStartTime),
        endtime: formatScheduleTime(offPeakEndTime),
      },
      offPeakPowerFlag: offPeakChargeOnlyEnabled ? 1 : 2,
    };
    payload.reservFlag = chargingEnabled ? 1 : 0;

    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/ccs2/reservation/chargehvac`;
    const response = await this.session.postJsonExpectJson(url, payload, {
      headers: await this._getControlHeaders(token, vehicleConfig),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  // Port of _schedule_ev5_flat — see scheduleChargingAndClimate for when
  // this is used instead of the combined /ccs2/reservation/chargehvac call.
  async _scheduleEv5Flat(token, vehicleConfig, options) {
    const {
      firstDeparture, secondDeparture, chargingEnabled, offPeakStartTime, offPeakEndTime,
      offPeakChargeOnlyEnabled, climateEnabled, temperatureUnit, defrost,
    } = options;
    const departures = [firstDeparture, secondDeparture];

    let temperature = options.temperature;
    if (temperatureUnit === 0) {
      temperature = Math.round(temperature * 2) / 2;
      if (temperature > 27) temperature = 27;
      else if (temperature < 17) temperature = 17;
    }

    const chargePayload = {
      reservFlag: chargingEnabled ? 1 : 0,
      offpeakPowerFlag: offPeakChargeOnlyEnabled ? 1 : 2,
      reservStartTime: formatScheduleTime(offPeakStartTime),
      reservEndTime: formatScheduleTime(offPeakEndTime),
    };

    const hvacPayload = {};
    departures.forEach((departure, i) => {
      hvacPayload[`reservedHVACInfo${i + 1}`] = {
        reservHVACflag: departure.enabled ? 1 : 0,
        reservInfo: { day: departure.days, time: formatScheduleTime(departure.time) },
        reservHVACSet: {
          airCtrl: climateEnabled ? 1 : 0,
          airTemp: { value: temperature.toFixed(1), hvacTempType: 1, unit: temperatureUnit },
          defrost,
        },
      };
    });

    const baseUrl = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/ccs2/reservation`;
    const headers = await this._getControlHeaders(token, vehicleConfig);
    const chargeResponse = await this.session.postJsonExpectJson(`${baseUrl}/charge`, chargePayload, { headers });
    checkResponseForErrors(chargeResponse);
    const hvacResponse = await this.session.postJsonExpectJson(`${baseUrl}/hvac`, hvacPayload, { headers });
    checkResponseForErrors(hvacResponse);
    return chargeResponse.msgId;
  }

  // Extra headers for the refresh_token grant. AU adds the Stamp header
  // here; EU overrides refreshAccessToken itself with a v2 JSON variant.
  _refreshAccessTokenHeaders() {
    return {};
  }

  async refreshAccessToken(token) {
    if (token.refreshToken) {
      try {
        const url = `${this.USER_API_URL}oauth2/token`;
        const headers = {
          Authorization: this.BASIC_AUTHORIZATION,
          Host: this.BASE_URL,
          Connection: 'close',
          'Accept-Encoding': 'gzip, deflate',
          ...this._refreshAccessTokenHeaders(),
        };
        const response = await this.session.postFormExpectJson(url, {
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
        }, { headers });
        checkResponseForErrors(response);
        token.accessToken = `${response.token_type} ${response.access_token}`;
        token.refreshToken = response.refresh_token || token.refreshToken;
        token.validUntil = new Date(Date.now() + (response.expires_in || 86400) * 1000);
        return token;
      } catch (error) {
        // fall back to a full login, just like upstream
      }
    }
    return this.login(token.username, token.password, token.pin);
  }
}

module.exports = { ApiImplType1, checkResponseForErrors, retryOnDeviceIdError };
