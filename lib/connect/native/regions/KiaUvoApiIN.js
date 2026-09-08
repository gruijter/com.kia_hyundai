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

// Port of KiaUvoApiIN.py (India — Hyundai Bluelink IN + Kia Connect IN).
// Same classic Type1 login as AU (cookies -> signin -> authorization code ->
// access token), no RSA and no OTP, so it fits the existing pairing form
// unchanged. Two things differ from every other Type1 region and are ported
// verbatim rather than "cleaned up":
//   - the access token and the refresh token come from TWO separate
//     oauth2/token calls (_getAccessToken then _getRefreshToken),
//   - _getRefreshToken stores "<type> <access_token>", not the refresh_token
//     field (upstream does the same; CN does too — see KiaUvoApiCN.js).
//
// Same deliberate deviation as the other regions here: the status calls
// return raw JSON in the common { vehicleStatus, vehicleLocation } shape
// (CCS2: the bare Vehicle object) instead of mutating a Vehicle dataclass,
// so drivers/car/device.js#mapStatus() works unchanged. See ../../NAMING.md.

const crypto = require('crypto');
const { ApiImplSession, USER_AGENT_OK_HTTP } = require('../http');
const { ApiImplType1, checkResponseForErrors, retryOnDeviceIdError } = require('../ApiImplType1');
const Token = require('../Token');
const { BRAND_HYUNDAI } = require('../const');
const {
  xorStamp, getChildValue, getIndexIntoHexTemp, nearestRangeIndex,
} = require('../utils');
const { AuthenticationError } = require('../exceptions');
const { prefixLogger } = require('../logger');

class KiaUvoApiIN extends ApiImplType1 {

  constructor(region, brand, language, { logger } = {}) {
    super();
    this.logger = prefixLogger(logger, 'KiaUvoApiIN');
    this.dataTimezone = 'Asia/Kolkata';
    // Python: tuple(x * 0.5 for x in range(28, 60)) -> 14.0 .. 29.5
    this.temperatureRange = Array.from({ length: 32 }, (_, i) => (28 + i) * 0.5);
    this.brand = brand;
    this.LANGUAGE = language;

    if (brand === BRAND_HYUNDAI) {
      this.BASE_DOMAIN = 'prd.in-ccapi.hyundai.connected-car.io';
      this.CCSP_SERVICE_ID = 'e5b3f6d0-7f83-43c9-aff3-a254db7af368';
      this.APP_ID = '5a27df80-4ca1-4154-8c09-6f4029d91cf7';
      this.cfb = Buffer.from('RFtoRq/vDXJmRndoZaZQyfOot7OrIqGVFj96iY2WL3yyH5Z/pUvlUhqmCxD2t+D65SQ=', 'base64');
      this.BASIC_AUTHORIZATION = 'Basic ZTViM2Y2ZDAtN2Y4My00M2M5LWFmZjMtYTI1NGRiN2FmMzY4OjVKRk9DcjZDMjRPZk96bERxWnA3RXdxcmtMMFd3MDRVYXhjRGlFNlVkM3FJNVNFNA==';
      this.PUSH_TYPE = 'GCM';
    } else {
      this.BASE_DOMAIN = 'prd.in-ccapi.kia.connected-car.io';
      this.CCSP_SERVICE_ID = 'd0fe4855-7527-4be0-ab6e-a481216c705d';
      this.APP_ID = '00000000-69cd-4660-b75d-277ae15379dd';
      this.cfb = Buffer.from('pdfn/jCrrEcxH6Jnak/1O/DaD+HjVh0P6z/BHWNoUKQtT0aLcYwer8BxQOoiHXSyMtBV', 'base64');
      this.BASIC_AUTHORIZATION = 'Basic ZDBmZTQ4NTUtNzUyNy00YmUwLWFiNmUtYTQ4MTIxNmM3MDVkOlNIb1R0WHB5ZmJZbVAzWGpOQTZCcnRsRGdseXBQV2o5MjBQdEtCSlBmbGVIRVlwVQ==';
      this.PUSH_TYPE = 'APNS';
    }

    this.PORT = 8080;
    this.BASE_URL = `${this.BASE_DOMAIN}:${this.PORT}`;
    this.USER_API_URL = `https://${this.BASE_URL}/api/v1/user/`;
    this.SPA_API_URL = `https://${this.BASE_URL}/api/v1/spa/`;
    this.SPA_API_URL_V2 = `https://${this.BASE_URL}/api/v2/spa/`;
    this.CLIENT_ID = this.CCSP_SERVICE_ID;
    this.session = new ApiImplSession({ logger: this.logger });

    [
      'updateVehicleWithCachedState', 'forceRefreshVehicleState', 'chargePortAction',
      'startHazardLights', 'startHazardLightsAndHorn',
    ].forEach((name) => {
      this[name] = retryOnDeviceIdError(this[name]).bind(this);
    });
  }

  // No Stamp and no Ccuccs2protocolsupport here, unlike the Type1 base —
  // upstream's IN headers carry neither.
  _getAuthenticatedHeaders(token) {
    return {
      Authorization: token.accessToken,
      'ccsp-service-id': this.CCSP_SERVICE_ID,
      'ccsp-application-id': this.APP_ID,
      'ccsp-device-id': token.deviceId,
      Host: this.BASE_URL,
      Connection: 'Keep-Alive',
      'Accept-Encoding': 'gzip',
      'User-Agent': USER_AGENT_OK_HTTP,
    };
  }

  async login(username, password, pin) {
    const stamp = this._getStamp();
    const deviceId = await this._getDeviceId(stamp);
    const cookies = await this._getCookies();

    let authorizationCode;
    try {
      authorizationCode = await this._getAuthorizationCodeWithRedirectUrl(username, password, cookies);
    } catch {
      authorizationCode = null;
    }
    if (!authorizationCode) throw new AuthenticationError('Login Failed');

    const [, accessToken, codeForRefresh] = await this._getAccessToken(stamp, authorizationCode);
    const [, refreshToken] = await this._getRefreshToken(stamp, codeForRefresh);
    // Upstream uses a fixed 23h lifetime here rather than expires_in.
    const validUntil = new Date(Date.now() + 23 * 60 * 60 * 1000);

    return new Token({
      username, password, pin, accessToken, refreshToken, deviceId, validUntil,
    });
  }

  async updateVehicleWithCachedState(token, vehicleConfig) {
    const isCcs2 = !!vehicleConfig.ccuCCS2ProtocolSupport;
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}${isCcs2 ? '/ccs2/carstatus/latest' : '/status/latest'}`;
    const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);

    if (isCcs2) return this._ccs2State(response, await this.getLocation(token, vehicleConfig));
    return {
      vehicleStatus: response.resMsg,
      vehicleLocation: await this.getLocation(token, vehicleConfig),
    };
  }

  async forceRefreshVehicleState(token, vehicleConfig) {
    if (vehicleConfig.ccuCCS2ProtocolSupport) {
      const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/ccs2/carstatus`;
      const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
      checkResponseForErrors(response);
      return this._ccs2State(response, await this.getLocation(token, vehicleConfig));
    }
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/status`;
    const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    return {
      vehicleStatus: response.resMsg,
      vehicleLocation: await this.getLocation(token, vehicleConfig),
    };
  }

  // Deviation from upstream, deliberately: KiaUvoApiIN.py hands the raw
  // `resMsg` of the /ccs2/ endpoints to a parser that only reads the LEGACY
  // fields (`time`, `engine`, `airTemp`), so its CCS2 path cannot work as
  // written. Every other region unwraps resMsg.state.Vehicle for these same
  // endpoints, so that is done here, falling back to resMsg when the wrapper
  // is absent. Unverifiable without an IN account — first thing to check if
  // an Indian CCS2 car reports no data.
  _ccs2State(response, location) {
    const state = getChildValue(response, 'resMsg.state.Vehicle') || response.resMsg;
    if (location && getChildValue(location, 'coord.lat') !== undefined) {
      state.Location = state.Location || {};
      state.Location.GeoCoord = {
        ...state.Location.GeoCoord,
        Latitude: location.coord.lat,
        Longitude: location.coord.lon,
      };
    }
    return state;
  }

  async getLocation(token, vehicleConfig) {
    try {
      const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/location/park`;
      const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
      checkResponseForErrors(response);
      return response.resMsg;
    } catch {
      return null;
    }
  }

  async odometer(token, vehicleConfig) {
    const state = await this.updateVehicleWithCachedState(token, vehicleConfig);
    if (vehicleConfig.ccuCCS2ProtocolSupport) {
      return { value: getChildValue(state, 'Drivetrain.Odometer') };
    }
    return getChildValue(state, 'vehicleStatus.odometer');
  }

  // Plain authenticated headers, no control token — upstream IN does not
  // PIN-verify the door command (every other Type1 region does).
  async lockAction(token, vehicleConfig, action) {
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/control/door`;
    const payload = { action, deviceId: token.deviceId };
    const response = await this.session.postJsonExpectJson(url, payload, {
      headers: this._getAuthenticatedHeaders(token),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  // Note the capital D in "deviceID" — upstream spells it that way for this
  // endpoint only, so it is kept.
  async chargePortAction(token, vehicleConfig, action) {
    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/control/portdoor`;
    const payload = { action, deviceID: token.deviceId };
    const response = await this.session.postJsonExpectJson(url, payload, {
      headers: await this._getControlHeaders(token, vehicleConfig),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  // Upstream IN always uses the legacy /control/engine shape, with no CCS2
  // branch at all (unlike the Type1 base this overrides).
  async startClimate(token, vehicleConfig, options = {}) {
    const setTemp = options.setTemp ?? 21;
    const duration = options.duration ?? 5;
    const defrost = options.defrost ?? false;
    const heating = options.heating ?? 0;
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/control/engine`;
    const payload = {
      action: 'start',
      hvacType: 1,
      options: { defrost, heating1: Number(heating), igniOnDuration: duration },
      tempCode: getIndexIntoHexTemp(nearestRangeIndex(this.temperatureRange, setTemp)),
      unit: 'C',
    };
    const response = await this.session.postJsonExpectJson(url, payload, {
      headers: this._getAuthenticatedHeaders(token),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async stopClimate(token, vehicleConfig) {
    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/control/engine`;
    const response = await this.session.postJsonExpectJson(url, { action: 'stop' }, {
      headers: await this._getControlHeaders(token, vehicleConfig),
    });
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

  async valetModeAction(token, vehicleConfig, action) {
    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/control/valet`;
    const response = await this.session.postJsonExpectJson(url, { action }, {
      headers: await this._getControlHeaders(token, vehicleConfig),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  // India is RHD, regardless of the odometer unit.
  _getDrvSeatLoc() {
    return 'R';
  }

  _getStamp() {
    return xorStamp(this.cfb, this.APP_ID);
  }

  async _getDeviceId(stamp) {
    const registrationId = crypto.randomBytes(32).toString('hex');
    const url = `${this.SPA_API_URL}notifications/register`;
    const payload = { pushRegId: registrationId, pushType: this.PUSH_TYPE, uuid: crypto.randomUUID() };
    const headers = {
      'ccsp-service-id': this.CCSP_SERVICE_ID,
      'ccsp-application-id': this.APP_ID,
      Stamp: stamp,
      'Content-Type': 'application/json;charset=UTF-8',
      Host: this.BASE_URL,
      Connection: 'Keep-Alive',
      'Accept-Encoding': 'gzip',
      'User-Agent': USER_AGENT_OK_HTTP,
    };
    const response = await this.session.postJsonExpectJson(url, payload, { headers });
    checkResponseForErrors(response);
    return response.resMsg.deviceId;
  }

  async _getCookies() {
    const url = `${this.USER_API_URL}oauth2/authorize?response_type=code&state=test&client_id=${this.CLIENT_ID}`
      + `&redirect_uri=${this.USER_API_URL}oauth2/redirect`;
    const session = new ApiImplSession({ logger: this.logger });
    await session.get(url);
    return Object.fromEntries(session.cookies);
  }

  async _getAuthorizationCodeWithRedirectUrl(username, password, cookies) {
    const url = `${this.USER_API_URL}signin`;
    const response = await this.session.postJsonExpectJson(url, { email: username, password }, {
      headers: { 'Content-type': 'application/json' },
      cookies,
    });
    const redirectUrl = new URL(response.redirectUrl);
    return redirectUrl.searchParams.get('code');
  }

  _tokenHeaders(stamp) {
    return {
      Authorization: this.BASIC_AUTHORIZATION,
      Stamp: stamp,
      Host: this.BASE_URL,
      Connection: 'close',
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': USER_AGENT_OK_HTTP,
    };
  }

  async _getAccessToken(stamp, authorizationCode) {
    const url = `${this.USER_API_URL}oauth2/token`;
    const response = await this.session.postFormExpectJson(url, {
      grant_type: 'authorization_code',
      redirect_uri: `https://${this.BASE_DOMAIN}:${this.PORT}/api/v1/user/oauth2/redirect`,
      code: authorizationCode,
    }, { headers: this._tokenHeaders(stamp) });
    const tokenType = response.token_type;
    // Upstream returns response["refresh_token"] as the third value and feeds
    // it straight into _get_refresh_token below, so it is named for what it
    // is used as rather than for the field it came from.
    return [tokenType, `${tokenType} ${response.access_token}`, response.refresh_token];
  }

  // Verbatim from upstream, oddities included: a second oauth2/token call
  // whose *access* token is stored as this session's refresh token, against a
  // getpostman.com redirect_uri.
  async _getRefreshToken(stamp, authorizationCode) {
    const url = `${this.USER_API_URL}oauth2/token`;
    const response = await this.session.postFormExpectJson(url, {
      grant_type: 'refresh_token',
      redirect_uri: 'https://www.getpostman.com/oauth2/callback',
      refresh_token: authorizationCode,
    }, { headers: this._tokenHeaders(stamp) });
    const tokenType = response.token_type;
    return [tokenType, `${tokenType} ${response.access_token}`];
  }

  _refreshAccessTokenHeaders() {
    return { Stamp: this._getStamp() };
  }

}

module.exports = KiaUvoApiIN;
