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

// Port of KiaUvoApiCA.py. A different backend than EU/AU/CN (kiaconnect.ca /
// mybluelink.ca), with PIN-verified "pAuth" tokens for EVERY control
// command (not cached like EU's control token) and a mandatory OTP step on
// an unrecognized device (errorCode 7110).
//
// KNOWN LIMITATION (still to validate, no test account available): the OTP
// methods (sendOtp/verifyOtpAndCompleteLogin) are ported, but this Homey
// app has NO pairing UI step yet that calls them — driver.js can currently
// only show an OTP challenge as a plain error, not handle it interactively.
// See ../../NAMING.md and the plan (Phase 3, CA) for the follow-up step.
//
// Same deliberate deviation as the other regions: raw JSON instead of a
// Vehicle dataclass, normalized to { vehicleStatus, vehicleLocation }.

const crypto = require('crypto');
const os = require('os');
const { ApiImplSession } = require('../http');
const ApiImpl = require('../ApiImpl');
const Token = require('../Token');
const {
  BRAND_KIA, VEHICLE_LOCK_ACTION, ORDER_STATUS, OTP_NOTIFY_TYPE,
} = require('../const');
const { getChildValue, getIndexIntoHexTemp } = require('../utils');
const { APIError, AuthenticationError, AuthenticationOTPRequired } = require('../exceptions');
const { prefixLogger } = require('../logger');

// UUID5 (SHA-1, namespace DNS) — Node has no built-in uuidv5, but Python's
// uuid.uuid5(NAMESPACE_DNS, ...) does. Needed for a stable device_id
// (MAC+hostname), so restarts don't trigger a new OTP every time.
const NAMESPACE_DNS = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
function uuid5(name) {
  const hash = crypto.createHash('sha1').update(NAMESPACE_DNS).update(name, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function getMacAddress() {
  const interfaces = Object.values(os.networkInterfaces()).flat();
  const withMac = interfaces.find((i) => i && i.mac && i.mac !== '00:00:00:00:00:00');
  return withMac ? withMac.mac.replace(/:/g, '') : '000000000000';
}

const CA_TEMPERATURE_MODEL_YEAR = 2020;

class KiaUvoApiCA extends ApiImpl {
  constructor(region, brand, language, { logger } = {}) {
    super();
    this.logger = prefixLogger(logger, 'KiaUvoApiCA');
    this.LANGUAGE = language;
    this.brand = brand;
    this.dataTimezone = 'America/Toronto';
    // equivalent to Python's temperature_range_c_old/_new
    this.temperatureRangeOld = Array.from({ length: 32 }, (_, i) => (32 + i) * 0.5);
    this.temperatureRangeNew = Array.from({ length: 36 }, (_, i) => (28 + i) * 0.5);

    this.BASE_URL = brand === BRAND_KIA ? 'kiaconnect.ca' : 'mybluelink.ca';
    this.API_URL = `https://${this.BASE_URL}/tods/api/`;
    this.API_HEADERS = {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-CA,en-US;q=0.8,en;q=0.5,fr;q=0.3',
      from: 'CWP',
      offset: '-5',
      language: '0',
      Origin: `https://${this.BASE_URL}`,
      Referer: `https://${this.BASE_URL}/login`,
      client_id: 'HATAHSPACA0232141ED9722C67715A0B',
      client_secret: 'CLISCR01AHSPA',
    };
    this.session = new ApiImplSession({ logger: this.logger });
    this._deviceId = null;
  }

  _getDeviceId() {
    if (!this._deviceId) {
      const name = uuid5(`${getMacAddress()}-${os.hostname() || ''}`);
      this._deviceId = Buffer.from(name.replace(/-/g, ''), 'utf8').toString('base64');
    }
    return this._deviceId;
  }

  _checkResponseForErrors(response) {
    const errorCodeMapping = {
      7404: AuthenticationError,
      7402: AuthenticationError,
      7403: AuthenticationError,
      7549: AuthenticationError,
      7602: AuthenticationError,
    };
    if (response.responseHeader && response.responseHeader.responseCode === 1) {
      const code = response.error && response.error.errorCode;
      if (code === '7110') return; // OTP required — afgehandeld in login()
      const ErrorClass = errorCodeMapping[code];
      if (ErrorClass) throw new ErrorClass(response.error.errorDesc || code);
      throw new APIError(`Server returned: '${(response.error && (response.error.errorDesc || response.error.errorCode)) || 'unknown'}'`);
    }
  }

  async login(username, password, pin) {
    const url = `${this.API_URL}v2/login`;
    const headers = { ...this.API_HEADERS, Deviceid: this._getDeviceId() };
    const response = await this.session.postJsonExpectJson(url, { loginId: username, password }, { headers });

    if (response.responseHeader && response.responseHeader.responseCode === 1
      && response.error && response.error.errorCode === '7110') {
      const selverifmethUrl = `${this.API_URL}mfa/selverifmeth`;
      const selverifmethJson = await this.session.postJsonExpectJson(selverifmethUrl, {
        mfaApiCode: '0107', userAccount: username,
      }, { headers: { ...this.API_HEADERS, Deviceid: this._getDeviceId() } });
      if (getChildValue(selverifmethJson, 'responseHeader.responseCode') !== 0) {
        throw new APIError(`Failed to get verification methods: ${getChildValue(selverifmethJson, 'error.errorDesc') || 'Unknown error'}`);
      }
      const result = selverifmethJson.result || {};
      throw new AuthenticationOTPRequired(
        `OTP verification required for this CA account (userInfoUuid=${result.userInfoUuid}). `
        + 'OTP-pairing is not yet supported by this Homey app — see lib/connect/NAMING.md.',
      );
    }

    this._checkResponseForErrors(response);
    const tokenData = response.result.token;
    return new Token({
      username,
      password,
      pin,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      deviceId: this._deviceId,
      validUntil: new Date(Date.now() + (Number(tokenData.expireIn) - 60) * 1000),
    });
  }

  // CA has no refresh endpoint; this just logs in again with the saved
  // device_id, so the server keeps recognizing the device.
  async refreshAccessToken(token) {
    if (token.deviceId) this._deviceId = token.deviceId;
    return this.login(token.username, token.password, token.pin);
  }

  async sendOtp(otpRequest, notifyType) {
    const url = `${this.API_URL}mfa/sendotp`;
    const headers = { ...this.API_HEADERS, Deviceid: this._getDeviceId() };
    let data;
    if (notifyType === OTP_NOTIFY_TYPE.EMAIL) {
      data = {
        otpMethod: 'E', mfaApiCode: '0107', userAccount: otpRequest.email, userPhone: '', userInfoUuid: otpRequest.requestId,
      };
    } else if (notifyType === OTP_NOTIFY_TYPE.SMS) {
      data = {
        otpMethod: 'S', mfaApiCode: '0107', userAccount: otpRequest.email, userPhone: otpRequest.sms, userInfoUuid: otpRequest.requestId,
      };
    } else {
      throw new Error('Invalid notify type');
    }
    const response = await this.session.postJsonExpectJson(url, data, { headers });
    if (getChildValue(response, 'responseHeader.responseCode') !== 0) {
      throw new APIError(`Failed to send OTP: ${getChildValue(response, 'error.errorDesc') || 'Unknown error'}`);
    }
    // eslint-disable-next-line no-param-reassign
    otpRequest.otpKey = response.result.otpKey;
  }

  async verifyOtpAndCompleteLogin(username, password, otpCode, otpRequest, pin) {
    const headers = { ...this.API_HEADERS, Deviceid: this._getDeviceId() };
    const verifyResponse = await this.session.postJsonExpectJson(`${this.API_URL}mfa/validateotp`, {
      otpNo: otpCode, userAccount: username, otpKey: otpRequest.otpKey, mfaApiCode: '0107',
    }, { headers });
    if (getChildValue(verifyResponse, 'responseHeader.responseCode') !== 0) {
      throw new AuthenticationError(`OTP verification failed: ${getChildValue(verifyResponse, 'error.errorDesc') || 'Invalid OTP code'}`);
    }
    if (!getChildValue(verifyResponse, 'result.verifiedOtp')) {
      throw new AuthenticationError('OTP verification failed');
    }
    const { otpValidationKey } = verifyResponse.result;

    const genResponse = await this.session.postJsonExpectJson(`${this.API_URL}mfa/genmfatkn`, {
      userAccount: username, otpEmail: otpRequest.email, mfaApiCode: '0107', otpValidationKey, mfaYn: 'Y',
    }, { headers });
    if (getChildValue(genResponse, 'responseHeader.responseCode') !== 0) {
      throw new AuthenticationError(`Failed to generate token: ${getChildValue(genResponse, 'error.errorDesc') || 'Token generation failed'}`);
    }
    const tokenData = genResponse.result.token;
    return new Token({
      username,
      password,
      pin,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      deviceId: this._deviceId,
      validUntil: new Date(Date.now() + (Number(tokenData.expireIn) - 60) * 1000),
    });
  }

  async getVehicles(token) {
    const url = `${this.API_URL}vhcllst`;
    const headers = { ...this.API_HEADERS, accessToken: token.accessToken };
    const response = await this.session.postJsonExpectJson(url, undefined, { headers });
    this._checkResponseForErrors(response);
    return response.result.vehicles.map((entry) => ({ ...entry, id: entry.vehicleId, name: entry.nickName }));
  }

  async _getCachedVehicleState(token, vehicleConfig) {
    const url = `${this.API_URL}lstvhclsts`;
    const headers = { ...this.API_HEADERS, accessToken: token.accessToken, vehicleId: vehicleConfig.id };
    const response = await this.session.postJsonExpectJson(url, undefined, { headers });
    this._checkResponseForErrors(response);
    return response.result.status;
  }

  async _getForcedVehicleState(token, vehicleConfig) {
    const url = `${this.API_URL}rltmvhclsts`;
    const headers = { ...this.API_HEADERS, accessToken: token.accessToken, vehicleId: vehicleConfig.id };
    const response = await this.session.postJsonExpectJson(url, undefined, { headers });
    this._checkResponseForErrors(response);
    return response.result.status;
  }

  async getLocation(token, vehicleConfig) {
    try {
      const pAuth = await this._getPinToken(token, vehicleConfig);
      const url = `${this.API_URL}fndmcr`;
      const headers = {
        ...this.API_HEADERS, accessToken: token.accessToken, vehicleId: vehicleConfig.id, from: 'SPA', pAuth,
      };
      const response = await this.session.postJsonExpectJson(url, { pin: token.pin }, { headers });
      if (getChildValue(response, 'responseHeader.responseCode') !== 0) throw new APIError('No Location Located');
      return response.result;
    } catch (error) {
      return null;
    }
  }

  async _getPinToken(token, vehicleConfig) {
    const url = `${this.API_URL}vrfypin`;
    const headers = { ...this.API_HEADERS, accessToken: token.accessToken, vehicleId: vehicleConfig.id };
    const response = await this.session.postJsonExpectJson(url, { pin: token.pin }, { headers });
    return response.result.pAuth;
  }

  async updateVehicleWithCachedState(token, vehicleConfig) {
    const status = await this._getCachedVehicleState(token, vehicleConfig);
    const location = await this.getLocation(token, vehicleConfig);
    return { vehicleStatus: status, vehicleLocation: location };
  }

  async forceRefreshVehicleState(token, vehicleConfig) {
    const status = await this._getForcedVehicleState(token, vehicleConfig);
    const location = await this.getLocation(token, vehicleConfig);
    return { vehicleStatus: status, vehicleLocation: location };
  }

  async odometer(token, vehicleConfig) {
    const status = await this._getCachedVehicleState(token, vehicleConfig);
    return { value: getChildValue(status, 'odometer') };
  }

  _temperatureRange(vehicleConfig) {
    return Number(vehicleConfig.modelYear) >= CA_TEMPERATURE_MODEL_YEAR ? this.temperatureRangeNew : this.temperatureRangeOld;
  }

  async lockAction(token, vehicleConfig, action) {
    const url = action === VEHICLE_LOCK_ACTION.LOCK ? `${this.API_URL}drlck` : `${this.API_URL}drulck`;
    const pAuth = await this._getPinToken(token, vehicleConfig);
    const headers = {
      ...this.API_HEADERS, accessToken: token.accessToken, vehicleId: vehicleConfig.id, pAuth,
    };
    const response = await this.session.postJson(url, { pin: token.pin }, { headers });
    await response.json();
    return response.headers.get('transactionId');
  }

  async startClimate(token, vehicleConfig, options = {}) {
    const isEV = !!vehicleConfig.isEV;
    const url = isEV ? `${this.API_URL}evc/rfon` : `${this.API_URL}rmtstrt`;
    const pAuth = await this._getPinToken(token, vehicleConfig);
    const headers = {
      ...this.API_HEADERS, accessToken: token.accessToken, vehicleId: vehicleConfig.id, pAuth,
    };

    const climate = options.climate ?? true;
    const setTemp = options.setTemp ?? 21;
    const duration = options.duration ?? 5;
    const heating = options.heating ?? 0;
    const defrost = options.defrost ?? false;
    const frontLeftSeat = options.frontLeftSeat ?? 0;
    const frontRightSeat = options.frontRightSeat ?? 0;
    const rearLeftSeat = options.rearLeftSeat ?? 0;
    const rearRightSeat = options.rearRightSeat ?? 0;
    const range = this._temperatureRange(vehicleConfig);
    const hexSetTemp = getIndexIntoHexTemp(range.indexOf(setTemp));

    let payload;
    if (isEV) {
      const climateSettings = {
        airCtrl: Number(climate),
        defrost,
        heating1: heating,
        airTemp: { value: hexSetTemp, unit: 0, hvacTempType: 1 },
        igniOnDuration: duration,
        seatHeaterVentCMD: {
          drvSeatOptCmd: frontLeftSeat, astSeatOptCmd: frontRightSeat, rlSeatOptCmd: rearLeftSeat, rrSeatOptCmd: rearRightSeat,
        },
      };
      // EV9 (Kia) / IONIQ 9 (Hyundai) use "remoteControl" instead of "hvacInfo".
      const usesRemoteControl = vehicleConfig.name === 'EV9' || vehicleConfig.model === 'IONIQ 9';
      payload = { pin: token.pin, [usesRemoteControl ? 'remoteControl' : 'hvacInfo']: climateSettings };
    } else {
      payload = {
        setting: {
          airCtrl: Number(climate),
          defrost,
          heating1: heating,
          igniOnDuration: duration,
          ims: 0,
          airTemp: { value: hexSetTemp, unit: 0, hvacTempType: 0 },
          seatHeaterVentCMD: {
            drvSeatOptCmd: frontLeftSeat, astSeatOptCmd: frontRightSeat, rlSeatOptCmd: rearLeftSeat, rrSeatOptCmd: rearRightSeat,
          },
        },
        pin: token.pin,
      };
    }
    const response = await this.session.postJson(url, payload, { headers });
    await response.json();
    return response.headers.get('transactionId');
  }

  async stopClimate(token, vehicleConfig) {
    const isEV = !!vehicleConfig.isEV;
    const url = isEV ? `${this.API_URL}evc/rfoff` : `${this.API_URL}rmtstp`;
    const pAuth = await this._getPinToken(token, vehicleConfig);
    const headers = {
      ...this.API_HEADERS, accessToken: token.accessToken, vehicleId: vehicleConfig.id, pAuth,
    };
    const response = await this.session.postJson(url, { pin: token.pin }, { headers });
    await response.json();
    return response.headers.get('transactionId');
  }

  async checkActionStatus(token, vehicleConfig, actionId) {
    const url = `${this.API_URL}rmtsts`;
    const pAuth = await this._getPinToken(token, vehicleConfig);
    const headers = {
      ...this.API_HEADERS, accessToken: token.accessToken, vehicleId: vehicleConfig.id, transactionId: actionId, pAuth,
    };
    const response = await this.session.getJson(url, { headers });
    this._checkResponseForErrors(response);
    const state = getChildValue(response, 'result.state');
    if (state === 'SUCCESS' || state === 'OK') return ORDER_STATUS.SUCCESS;
    if (state === 'FAIL' || state === 'FAILURE') return ORDER_STATUS.FAILED;
    return ORDER_STATUS.PENDING;
  }

  async startCharge(token, vehicleConfig) {
    const url = `${this.API_URL}evc/rcstrt`;
    const pAuth = await this._getPinToken(token, vehicleConfig);
    const headers = {
      ...this.API_HEADERS, accessToken: token.accessToken, vehicleId: vehicleConfig.id, pAuth,
    };
    const response = await this.session.postJson(url, { pin: token.pin }, { headers });
    await response.json();
    return response.headers.get('transactionId');
  }

  async stopCharge(token, vehicleConfig) {
    const url = `${this.API_URL}evc/rcstp`;
    const pAuth = await this._getPinToken(token, vehicleConfig);
    const headers = {
      ...this.API_HEADERS, accessToken: token.accessToken, vehicleId: vehicleConfig.id, pAuth,
    };
    const response = await this.session.postJson(url, { pin: token.pin }, { headers });
    await response.json();
    return response.headers.get('transactionId');
  }

  async setChargeLimits(token, vehicleConfig, ac, dc) {
    const url = `${this.API_URL}evc/setsoc`;
    const pAuth = await this._getPinToken(token, vehicleConfig);
    const headers = {
      ...this.API_HEADERS, accessToken: token.accessToken, vehicleId: vehicleConfig.id, pAuth, from: 'SPA',
    };
    const payload = {
      tsoc: [
        { plugType: 0, level: Number(dc) },
        { plugType: 1, level: Number(ac) },
      ],
      pin: token.pin,
    };
    const response = await this.session.postJson(url, payload, { headers });
    await response.json();
    return response.headers.get('transactionId');
  }
}

module.exports = KiaUvoApiCA;
