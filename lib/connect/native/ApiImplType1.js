'use strict';

const { promisify } = require('util');
const ApiImpl = require('./ApiImpl');
const { ApiImplSession, USER_AGENT_OK_HTTP } = require('./http');
const { VEHICLE_LOCK_ACTION, ORDER_STATUS } = require('./const');
const { getIndexIntoHexTemp } = require('./utils');

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

// Poort van ApiImplType1.py#_check_response_for_errors.
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

// Poort van ApiImplType1.py#_retry_on_device_id_error: bij een DeviceIDError
// registreert de EU-server het device_id soms af (bv. na een mislukte
// push-delivery); dit her-registreert het device_id en probeert 1x opnieuw.
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

// Poort van ApiImplType1.py: gedeelde besturingslogica voor de "Type 1" familie
// van regio's (EU en verwanten). Subklassen zetten de merk/regio-specifieke
// constanten (SPA_API_URL, CCSP_SERVICE_ID, APP_ID, ...) in hun constructor.
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

  // Poort van get_vehicles: geeft de raw vehicle-list entries terug (met een
  // paar aliassen voor bluelinky-achtige veldnamen), niet een Vehicle-dataclass —
  // zie ../NAMING.md.
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

  // ac = slow (Type2/AC) doellimiet, dc = fast (DC) doellimiet — zie ../NAMING.md.
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
    // EU/CN: kilometer-markten zijn LHD. AU/IN overschrijven dit met "R".
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

  // poiList: array van rauwe POI-objecten (device.js bouwt deze al in de vorm
  // die de server verwacht — zie ../NAMING.md).
  async setNavigation(token, vehicleConfig, poiList) {
    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/location/routes`;
    const payload = { deviceID: token.deviceId, poiInfoList: poiList };
    const response = await this.session.postJsonExpectJson(url, payload, {
      headers: await this._getControlHeaders(token, vehicleConfig),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  // Extra headers voor de refresh_token-grant. AU voegt hier de Stamp-header
  // toe; EU overschrijft refreshAccessToken zelf met een v2 JSON-variant.
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
        // val terug op volledige login, net als upstream
      }
    }
    return this.login(token.username, token.password, token.pin);
  }
}

module.exports = { ApiImplType1, checkResponseForErrors, retryOnDeviceIdError };
