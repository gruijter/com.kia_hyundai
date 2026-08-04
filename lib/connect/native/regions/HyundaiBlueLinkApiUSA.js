'use strict';

// Port of HyundaiBlueLinkApiUSA.py. A different backend than Kia USA
// (api.telematics.hyundaiusa.com, header-based auth with "accessToken" +
// "blueLinkServicePin"), but the raw status shape (vehicleStatus.airCtrlOn,
// .doorLock, .doorOpen.frontLeft, .evStatus.*, ...) is nearly identical to
// the EU/old-style convention — so almost no normalization is needed here,
// unlike Kia USA. See ../../NAMING.md.
//
// Just like Kia USA, the server requires a lowered TLS security level
// (SECLEVEL=1, see cipherAdapter in the Python source). UNTESTED: no
// Hyundai USA account available to validate this against.

const https = require('https');
const { ApiImplSession } = require('../http');
const ApiImpl = require('../ApiImpl');
const Token = require('../Token');
const { VEHICLE_LOCK_ACTION } = require('../const');
const { APIError, ServiceTemporaryUnavailable } = require('../exceptions');
const { prefixLogger } = require('../logger');

const HYUNDAI_USA_HTTPS_AGENT = new https.Agent({
  ciphers: 'DEFAULT@SECLEVEL=1',
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
});

function checkResponseForErrors(response) {
  if (response && response.errorCode !== undefined) {
    const suffix = response.systemName || response.functionName
      ? ` [${response.systemName || ''}/${response.functionName || ''}]`
      : '';
    const code = String(response.errorCode);
    const ErrorClass = code === '502' ? ServiceTemporaryUnavailable : APIError;
    throw new ErrorClass(`API Error ${code}${suffix}: ${response.errorMessage}`);
  }
}

// Control commands often return HTTP 200 with an empty body.
async function safeParseJson(response, actionName) {
  if (response.status !== 200) {
    const text = await response.text().catch(() => '');
    throw new APIError(`${actionName} failed with HTTP ${response.status}: '${text.slice(0, 200)}'`);
  }
  const text = await response.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

function getTransactionId(response) {
  return response.headers.get('tmsTid') || response.headers.get('transactionId') || response.headers.get('Xid') || null;
}

class HyundaiBlueLinkApiUSA extends ApiImpl {
  constructor(region, brand, language, { logger } = {}) {
    super();
    this.logger = prefixLogger(logger, 'HyundaiBlueLinkApiUSA');
    this.LANGUAGE = language;
    this.BASE_URL = 'api.telematics.hyundaiusa.com';
    this.LOGIN_API = `https://${this.BASE_URL}/v2/ac/`;
    this.API_URL = `https://${this.BASE_URL}/ac/v2/`;
    this.temperatureRange = Array.from({ length: 20 }, (_, i) => 62 + i); // 62..81

    const utcOffsetHours = -(new Date().getTimezoneOffset()) / 60;
    this.API_HEADERS = {
      'content-type': 'application/json;charset=UTF-8',
      accept: 'application/json, text/plain, */*',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/75.0.3770.142 Safari/537.36',
      host: this.BASE_URL,
      origin: `https://${this.BASE_URL}`,
      referer: `https://${this.BASE_URL}/login`,
      from: 'SPA',
      to: 'ISS',
      language: '0',
      offset: String(Math.trunc(utcOffsetHours)),
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      refresh: 'false',
      encryptFlag: 'false',
      brandIndicator: 'H',
      client_id: 'm66129Bb-em93-SPAHYN-bZ91-am4540zp19920',
      clientSecret: 'v558o935-6nne-423i-baa8',
    };
    this.session = new ApiImplSession({ httpsAgent: HYUNDAI_USA_HTTPS_AGENT, logger: this.logger });
    this._enrollmentDetailsCache = null;
  }

  _getAuthenticatedHeaders(token) {
    return {
      ...this.API_HEADERS,
      username: token.username,
      accessToken: token.accessToken,
      blueLinkServicePin: token.pin,
    };
  }

  _getVehicleHeaders(token, vehicleConfig) {
    return {
      ...this._getAuthenticatedHeaders(token),
      registrationId: vehicleConfig.id,
      gen: String(vehicleConfig.generation),
      vin: vehicleConfig.vin,
    };
  }

  async login(username, password, pin) {
    const url = `${this.LOGIN_API}oauth/token`;
    const response = await this.session.postJsonExpectJson(url, { username, password }, { headers: this.API_HEADERS });
    checkResponseForErrors(response);
    if (!response.access_token) {
      throw new APIError(`Error Code: ${response.errorCode || ''} - Login failed: ${response.errorMessage || ''}`);
    }
    return new Token({
      username,
      password,
      pin,
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      validUntil: new Date(Date.now() + Number(response.expires_in) * 1000),
    });
  }

  async refreshAccessToken(token) {
    if (token.refreshToken) {
      try {
        const url = `${this.LOGIN_API}oauth/token`;
        const response = await this.session.postJsonExpectJson(url, {
          username: token.username,
          password: token.password,
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
        }, { headers: this.API_HEADERS });
        checkResponseForErrors(response);
        if (!response.access_token) throw new APIError(`refresh_access_token: no access_token in response ${JSON.stringify(response)}`);
        return new Token({
          username: token.username,
          password: token.password,
          pin: token.pin,
          accessToken: response.access_token,
          refreshToken: response.refresh_token || token.refreshToken,
          validUntil: new Date(Date.now() + Number(response.expires_in) * 1000),
        });
      } catch (error) {
        // fall back to a full login, just like upstream
      }
    }
    return this.login(token.username, token.password, token.pin);
  }

  async _getEnrollmentDetails(token, forceRefresh = false) {
    if (this._enrollmentDetailsCache && !forceRefresh) return this._enrollmentDetailsCache;
    const url = `${this.API_URL}enrollment/details/${token.username}`;
    const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    if (!response.enrolledVehicleDetails) throw new APIError('Missing enrolledVehicleDetails in response');
    this._enrollmentDetailsCache = response;
    return response;
  }

  async getVehicles(token) {
    const response = await this._getEnrollmentDetails(token, true);
    return response.enrolledVehicleDetails.map(({ vehicleDetails: entry }) => ({
      ...entry,
      id: entry.regid,
      name: entry.nickName,
      vin: entry.vin,
      model: entry.modelCode,
      generation: Number(entry.vehicleGeneration || 2),
      isEV: entry.evStatus === 'E',
      isPHEV: entry.evStatus === 'P',
    }));
  }

  async _getVehicleDetails(token, vehicleConfig) {
    const response = await this._getEnrollmentDetails(token);
    const match = response.enrolledVehicleDetails.find((e) => e.vehicleDetails.regid === vehicleConfig.id);
    return match ? match.vehicleDetails : null;
  }

  async _getVehicleStatus(token, vehicleConfig, refresh) {
    const url = `${this.API_URL}rcs/rvs/vehicleStatus`;
    const headers = this._getVehicleHeaders(token, vehicleConfig);
    if (refresh) headers.REFRESH = 'true';
    const response = await this.session.getJson(url, { headers });
    checkResponseForErrors(response);
    const status = { ...response.vehicleStatus };
    if (status.dateTime) {
      status.dateTime = status.dateTime.replace(/[-T:Z]/g, '');
    }
    return status;
  }

  async _getVehicleLocation(token, vehicleConfig) {
    try {
      const url = `${this.API_URL}rcs/rfc/findMyCar`;
      const response = await this.session.getJson(url, { headers: this._getVehicleHeaders(token, vehicleConfig) });
      checkResponseForErrors(response);
      if (response.coord) return response;
      return null;
    } catch (error) {
      return null;
    }
  }

  async _buildStatus(token, vehicleConfig, refresh) {
    const vehicleStatus = await this._getVehicleStatus(token, vehicleConfig, refresh);
    const location = await this._getVehicleLocation(token, vehicleConfig);
    if (location) vehicleStatus.vehicleLocation = location;
    return { vehicleStatus };
  }

  async updateVehicleWithCachedState(token, vehicleConfig) {
    return this._buildStatus(token, vehicleConfig, false);
  }

  async forceRefreshVehicleState(token, vehicleConfig) {
    return this._buildStatus(token, vehicleConfig, true);
  }

  async odometer(token, vehicleConfig) {
    const details = await this._getVehicleDetails(token, vehicleConfig);
    return { value: details ? details.odometer : undefined };
  }

  async lockAction(token, vehicleConfig, action) {
    const url = action === VEHICLE_LOCK_ACTION.LOCK ? `${this.API_URL}rcs/rdo/off` : `${this.API_URL}rcs/rdo/on`;
    const headers = { ...this._getVehicleHeaders(token, vehicleConfig), 'APPCLOUD-VIN': vehicleConfig.vin };
    const response = await this.session.postJson(url, { userName: token.username, vin: vehicleConfig.vin }, { headers });
    const responseJson = await safeParseJson(response, 'lock_action');
    if (responseJson) checkResponseForErrors(responseJson);
    return getTransactionId(response);
  }

  async startClimate(token, vehicleConfig, options = {}) {
    const isEV = !!vehicleConfig.isEV;
    const url = isEV ? `${this.API_URL}evc/fatc/start` : `${this.API_URL}rcs/rsc/start`;
    const headers = this._getVehicleHeaders(token, vehicleConfig);

    const climate = options.climate ?? true;
    const setTemp = options.setTemp ?? 70;
    const duration = options.duration ?? 5;
    const heating = options.heating ?? 0;
    const defrost = options.defrost ?? false;
    const frontLeftSeat = options.frontLeftSeat ?? 0;
    const frontRightSeat = options.frontRightSeat ?? 0;
    const rearLeftSeat = options.rearLeftSeat ?? 0;
    const rearRightSeat = options.rearRightSeat ?? 0;

    let data;
    if (isEV) {
      data = {
        airCtrl: Number(climate),
        airTemp: { value: String(setTemp), unit: 1 },
        defrost,
        heating1: Number(heating),
      };
      // Older generations don't support seat-heater-vent info or duration.
      if (vehicleConfig.generation === 3) {
        data.igniOnDuration = duration;
        data.seatHeaterVentInfo = {
          drvSeatHeatState: frontLeftSeat, astSeatHeatState: frontRightSeat, rlSeatHeatState: rearLeftSeat, rrSeatHeatState: rearRightSeat,
        };
      }
    } else {
      data = {
        Ims: 0,
        airCtrl: Number(climate),
        airTemp: { unit: 1, value: setTemp },
        defrost,
        heating1: Number(heating),
        igniOnDuration: duration,
        seatHeaterVentInfo: {
          drvSeatHeatState: frontLeftSeat, astSeatHeatState: frontRightSeat, rlSeatHeatState: rearLeftSeat, rrSeatHeatState: rearRightSeat,
        },
        username: token.username,
        vin: vehicleConfig.id,
      };
    }
    const response = await this.session.postJson(url, data, { headers });
    const responseJson = await safeParseJson(response, 'start_climate');
    if (responseJson) checkResponseForErrors(responseJson);
    return getTransactionId(response);
  }

  async stopClimate(token, vehicleConfig) {
    const isEV = !!vehicleConfig.isEV;
    const url = isEV ? `${this.API_URL}evc/fatc/stop` : `${this.API_URL}rcs/rsc/stop`;
    const response = await this.session.request('POST', url, { headers: this._getVehicleHeaders(token, vehicleConfig) });
    const responseJson = await safeParseJson(response, 'stop_climate');
    if (responseJson) checkResponseForErrors(responseJson);
    return getTransactionId(response);
  }

  async startCharge(token, vehicleConfig) {
    if (!vehicleConfig.isEV) return null;
    const url = `${this.API_URL}evc/charge/start`;
    const response = await this.session.request('POST', url, { headers: this._getVehicleHeaders(token, vehicleConfig) });
    const responseJson = await safeParseJson(response, 'start_charge');
    if (responseJson) checkResponseForErrors(responseJson);
    return getTransactionId(response);
  }

  async stopCharge(token, vehicleConfig) {
    if (!vehicleConfig.isEV) return null;
    const url = `${this.API_URL}evc/charge/stop`;
    const response = await this.session.request('POST', url, { headers: this._getVehicleHeaders(token, vehicleConfig) });
    const responseJson = await safeParseJson(response, 'stop_charge');
    if (responseJson) checkResponseForErrors(responseJson);
    return getTransactionId(response);
  }

  async setChargeLimits(token, vehicleConfig, ac, dc) {
    if (!vehicleConfig.isEV) return null;
    const url = `${this.API_URL}evc/charge/targetsoc/set`;
    const data = {
      targetSOClist: [
        { plugType: 0, targetSOClevel: Number(dc) },
        { plugType: 1, targetSOClevel: Number(ac) },
      ],
    };
    const response = await this.session.postJson(url, data, { headers: this._getVehicleHeaders(token, vehicleConfig) });
    const responseJson = await safeParseJson(response, 'set_charge_limits');
    if (responseJson) checkResponseForErrors(responseJson);
    return getTransactionId(response);
  }

  async startHazardLights(token, vehicleConfig) {
    const url = `${this.API_URL}rcs/rhl/light`;
    const headers = { ...this._getVehicleHeaders(token, vehicleConfig), 'APPCLOUD-VIN': vehicleConfig.vin };
    const response = await this.session.postJson(url, { userName: token.username, vin: vehicleConfig.vin }, { headers });
    const responseJson = await safeParseJson(response, 'start_hazard_lights');
    if (responseJson) checkResponseForErrors(responseJson);
    return getTransactionId(response);
  }
}

module.exports = HyundaiBlueLinkApiUSA;
