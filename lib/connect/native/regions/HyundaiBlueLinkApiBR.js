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

// Port of HyundaiBlueLinkApiBR.py (Brazil — Hyundai BlueLink BR only; the
// region has no Kia backend, and upstream raises for any other brand).
//
// Type1-shaped but with its own auth, headers and endpoint selection:
//   - every authenticated call carries the fixed BR app header block
//     (User-Agent, offset, ccuCCS2ProtocolSupport) and "Bearer <token>",
//     rather than Type1's Stamp/ccsp header set — there is no Stamp at all,
//   - the cached status is CCS2-shaped even though BR vehicles report
//     ccuCCS2ProtocolSupport: 0; the legacy /status/latest endpoint is the
//     command-result feed there and always answers 503,
//   - force refresh is asynchronous: wake, wait, re-read /latest, and only
//     accept the result if lastUpdateTime actually advanced,
//   - every remote command needs the PIN control token, so pairing without a
//     PIN pairs fine but cannot control the car.
//
// Same deliberate deviation as the other regions: status calls return raw
// JSON (here always the CCS2 Vehicle object) instead of mutating a Vehicle
// dataclass, so drivers/car/device.js#mapStatus() works unchanged.
// See ../../NAMING.md.

const crypto = require('crypto');
const util = require('util');
const { ApiImplSession } = require('../http');
const { ApiImplType1, checkResponseForErrors, retryOnDeviceIdError } = require('../ApiImplType1');
const Token = require('../Token');
const { BRAND_HYUNDAI, WINDOW_STATE } = require('../const');
const { getChildValue, getIndexIntoHexTemp } = require('../utils');
const { APIError, AuthenticationError } = require('../exceptions');
const { prefixLogger } = require('../logger');

const wait = util.promisify(setTimeout);

// The BR signin endpoint answers 200 with {"step": N} and no redirectUrl when
// the account must finish something in the Bluelink app or web portal first.
// Numbers map to the routes in the login SPA bundle (/web/v1/user static JS).
const SIGNIN_STEP_MESSAGES = {
  0: 'the account must accept the terms of service',
  3: 'the account must accept the data-access agreement',
  4: 'the account must re-accept updated terms of service',
  5: 'the account password has expired and must be reset',
  6: 'the account is not activated yet',
  7: 'identity verification is required',
  8: 'identity verification is required',
  9: 'the account is blocked',
  10: 'email verification is required',
  11: 'the account email must be changed',
  12: 'identity verification is required',
  13: 'email verification is required',
};

class HyundaiBlueLinkApiBR extends ApiImplType1 {

  constructor(region, brand, language, { logger } = {}) {
    super();
    if (brand !== BRAND_HYUNDAI) {
      throw new APIError(`Unknown brand ${brand} for region Brazil. Only Hyundai is supported.`);
    }
    this.logger = prefixLogger(logger, 'HyundaiBlueLinkApiBR');
    this.dataTimezone = 'America/Sao_Paulo';
    this.temperatureRange = Array.from({ length: 20 }, (_, i) => 62 + i); // Python: range(62, 82)
    this.brand = brand;
    this.LANGUAGE = language || 'pt-BR';

    this.BASE_URL = 'br-ccapi.hyundai.com.br';
    this.API_URL = `https://${this.BASE_URL}/api/v1/`;
    this.API_V2_URL = `https://${this.BASE_URL}/api/v2/`;
    this.CCSP_SERVICE_ID = '03f7df9b-7626-4853-b7bd-ad1e8d722bd5';
    this.APP_ID = '513a491a-0d7c-4d6a-ac03-a2df127d73b0';
    this.BASIC_AUTHORIZATION = 'Basic MDNmN2RmOWItNzYyNi00ODUzLWI3YmQtYWQxZThkNzIyYmQ1OnlRejJiYzZDbjhPb3ZWT1I3UkRXd3hUcVZ3V0czeUtCWUZEZzBIc09Yc3l4eVBsSA==';

    // Type1's inherited methods (charging, navigation, action status, ...)
    // address this.USER_API_URL/SPA_API_URL/SPA_API_URL_V2. Upstream BR only
    // defines its own lowercase attributes, so those inherited methods raise
    // AttributeError there. Pointing them at BR's real API roots costs
    // nothing and is strictly better than an undefined URL — BR's own
    // overrides below still take precedence wherever it has one.
    this.USER_API_URL = `${this.API_URL}user/`;
    this.SPA_API_URL = `${this.API_URL}spa/`;
    this.SPA_API_URL_V2 = `${this.API_V2_URL}spa/`;

    this.API_HEADERS = {
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
      'Accept-Encoding': 'br;q=1.0, gzip;q=0.9, deflate;q=0.8',
      'Accept-Language': 'pt-BR;q=1.0, en-US;q=0.9',
      'User-Agent': 'BR_BlueLink/1.0.14 (com.hyundai.bluelink.br; build:10132; iOS 18.4.0) Alamofire/5.9.1',
      Host: this.BASE_URL,
      offset: '-3',
      ccuCCS2ProtocolSupport: '0',
    };

    this.session = new ApiImplSession({ logger: this.logger });
    // Registered once per session and reused, so a re-login doesn't register
    // a new push device every time.
    this.registeredDeviceId = null;

    [
      'getVehicles', 'updateVehicleWithCachedState', 'lockAction', 'setWindowsState',
      'startClimate', 'stopClimate', 'startHazardLights',
    ].forEach((name) => {
      this[name] = retryOnDeviceIdError(this[name]).bind(this);
    });
  }

  _apiUrl(path) {
    return `${this.API_URL}${path.replace(/^\//, '')}`;
  }

  _apiV2Url(path) {
    return `${this.API_V2_URL}${path.replace(/^\//, '')}`;
  }

  // BR sends no Stamp header; the shared retry helper still asks for one.
  _getStamp() {
    return undefined;
  }

  _getAuthenticatedHeaders(token) {
    return {
      ...this.API_HEADERS,
      'ccsp-device-id': token.deviceId || this.registeredDeviceId,
      'ccsp-application-id': this.APP_ID,
      Authorization: `Bearer ${token.accessToken}`,
    };
  }

  // Command headers: the PIN control token replaces the bearer, and the
  // vehicle's own protocol flag replaces the header block's fixed "0".
  async _commandHeaders(token, vehicleConfig) {
    const controlToken = await this._ensureControlToken(token);
    const deviceId = token.deviceId || await this._ensureDeviceId();
    return {
      ...this._getAuthenticatedHeaders(token),
      Authorization: controlToken,
      'ccsp-device-id': deviceId,
      ccuCCS2ProtocolSupport: String(vehicleConfig.ccuCCS2ProtocolSupport || 0),
    };
  }

  // The BR backend validates ccsp-device-id against its own registry and
  // answers resCode 4002 ("Invalid deviceId") on every authenticated SPA call
  // for a client-generated or invalidated id, so it must come from
  // /spa/notifications/register — same as EU and IN.
  async _getDeviceId() {
    const registrationId = crypto.randomBytes(32).toString('hex');
    const url = this._apiUrl('/spa/notifications/register');
    const payload = { pushRegId: registrationId, pushType: 'APNS', uuid: crypto.randomUUID() };
    const headers = {
      ...this.API_HEADERS,
      'ccsp-service-id': this.CCSP_SERVICE_ID,
      'ccsp-application-id': this.APP_ID,
    };
    const response = await this.session.postJsonExpectJson(url, payload, { headers });
    checkResponseForErrors(response);
    this.registeredDeviceId = response.resMsg.deviceId;
    return this.registeredDeviceId;
  }

  async _ensureDeviceId() {
    return this.registeredDeviceId || this._getDeviceId();
  }

  // Turns BR's auth failures into something a user can act on: the {step: N}
  // "finish this in the app first" states, then errCode/errMsg. Only those
  // fields are surfaced — never the whole body.
  _signinError(data, context) {
    const reason = SIGNIN_STEP_MESSAGES[data?.step];
    if (reason) {
      return new AuthenticationError(`Brazilian Hyundai login incomplete: ${reason} (${context} step=${data.step}). `
        + 'Complete this in the Bluelink app or web portal, then retry.');
    }
    const errCode = data?.errCode || data?.errorCode;
    const errMsg = data?.errMsg || data?.errorMessage;
    if (errCode || errMsg) {
      return new AuthenticationError(`Brazilian Hyundai ${context} failed: errCode=${errCode}, errMsg=${errMsg}`);
    }
    return null;
  }

  async login(username, password, pin) {
    const cookies = await this._getCookies();
    const authorizationCode = await this._getAuthorizationCode(cookies, username, password);
    const auth = await this._getAuthResponse(authorizationCode);
    const validUntil = new Date(Date.now() + Number(auth.expires_in) * 1000);

    return new Token({
      username,
      password,
      pin,
      accessToken: auth.access_token,
      refreshToken: auth.refresh_token,
      deviceId: await this._ensureDeviceId(),
      validUntil,
    });
  }

  async _getCookies() {
    const url = `${this._apiUrl('/user/oauth2/authorize')}?response_type=code`
      + `&client_id=${this.CCSP_SERVICE_ID}`
      + `&redirect_uri=${encodeURIComponent(this._apiUrl('/user/oauth2/redirect'))}`;
    const session = new ApiImplSession({ logger: this.logger });
    // The 'account' cookie is set during the 302, so it lives in the jar
    // rather than on the final response.
    await session.get(url);
    return Object.fromEntries(session.cookies);
  }

  async _getAuthorizationCode(cookies, username, password) {
    const url = this._apiUrl('/user/signin');
    const headers = {
      Referer: 'https://br-ccapi.hyundai.com.br/web/v1/user/signin',
      'Accept-Encoding': 'gzip, deflate, br',
      Accept: '*/*',
      Connection: 'keep-alive',
      'Content-Type': 'text/plain;charset=UTF-8',
      Host: this.BASE_URL,
      'Accept-Language': 'pt-BR,en-US;q=0.9,en;q=0.8',
      Origin: 'https://br-ccapi.hyundai.com.br',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) '
        + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148_CCS_APP_iOS',
    };
    const response = await this.session.postJsonExpectJson(url, { email: username, password }, { headers, cookies });

    if (!response.redirectUrl) {
      throw this._signinError(response, 'signin')
        || new AuthenticationError('Brazilian Hyundai login failed: no redirectUrl in the signin response. '
          + 'Check your username and password.');
    }
    const code = new URL(response.redirectUrl).searchParams.get('code');
    if (!code) throw new AuthenticationError('Brazilian Hyundai login failed: no authorization code in redirect URL.');
    return code;
  }

  async _getAuthResponse(authorizationCode) {
    const url = this._apiUrl('/user/oauth2/token');
    const headers = {
      'User-Agent': this.API_HEADERS['User-Agent'],
      Authorization: this.BASIC_AUTHORIZATION,
    };
    const response = await this.session.postFormExpectJson(url, {
      client_id: this.CCSP_SERVICE_ID,
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: this._apiUrl('/user/oauth2/redirect'),
    }, { headers });
    if (!response.access_token) {
      throw this._signinError(response, 'token request')
        || new AuthenticationError('Brazilian Hyundai token request failed.');
    }
    return response;
  }

  // Type1's refresh targets USER_API_URL with a Stamp and prefixes the token
  // type onto the access token, neither of which BR accepts — it builds its
  // own "Bearer " prefix in the headers. Falls back to a full login, which is
  // the normal path once the refresh token has expired.
  async refreshAccessToken(token) {
    if (token.refreshToken) {
      try {
        const url = this._apiUrl('/user/oauth2/token');
        const response = await this.session.postFormExpectJson(url, {
          client_id: this.CCSP_SERVICE_ID,
          grant_type: 'refresh_token',
          refresh_token: token.refreshToken,
        }, {
          headers: {
            'User-Agent': this.API_HEADERS['User-Agent'],
            Authorization: this.BASIC_AUTHORIZATION,
          },
        });
        if (!response.access_token) throw new AuthenticationError('no access_token in refresh response');
        return new Token({
          username: token.username,
          password: token.password,
          pin: token.pin,
          accessToken: response.access_token,
          refreshToken: response.refresh_token || token.refreshToken,
          deviceId: token.deviceId,
          validUntil: new Date(Date.now() + Number(response.expires_in) * 1000),
        });
      } catch {
        this.logger.log('refreshAccessToken: exchange failed, falling back to a full login');
      }
    }
    return this.login(token.username, token.password, token.pin);
  }

  async getVehicles(token) {
    const url = this._apiUrl('/spa/vehicles');
    const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    if (!response.resMsg?.vehicles) throw new APIError('Missing resMsg or vehicles in response');
    return response.resMsg.vehicles.map((entry) => ({
      ...entry,
      id: entry.vehicleId,
      name: entry.vehicleName,
    }));
  }

  // BR vehicles report ccuCCS2ProtocolSupport: 0, but the cached status is
  // served in CCS2 format (location included) at /ccs2/carstatus/latest. The
  // legacy /status/latest endpoint is the remote-command result feed here and
  // always answers 503 / resCode 5031, so it is never used.
  async updateVehicleWithCachedState(token, vehicleConfig) {
    const url = this._apiUrl(`/spa/vehicles/${vehicleConfig.id}/ccs2/carstatus/latest`);
    const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    return getChildValue(response, 'resMsg.state.Vehicle');
  }

  // Asynchronous: GET /ccs2/carstatus only acknowledges, then the car pushes a
  // fresh snapshot to /latest. Wake, wait, re-read — and refuse to return
  // stale data if lastUpdateTime did not advance.
  async forceRefreshVehicleState(token, vehicleConfig) {
    const headers = this._getAuthenticatedHeaders(token);
    const latestUrl = this._apiUrl(`/spa/vehicles/${vehicleConfig.id}/ccs2/carstatus/latest`);
    const triggerUrl = this._apiUrl(`/spa/vehicles/${vehicleConfig.id}/ccs2/carstatus`);

    const pre = await this.session.getJson(latestUrl, { headers });
    const baselineTs = pre.resMsg?.lastUpdateTime;

    await this.session.getJson(triggerUrl, { headers });
    await wait(25 * 1000);

    const response = await this.session.getJson(latestUrl, { headers });
    checkResponseForErrors(response);
    if (response.resMsg?.lastUpdateTime === baselineTs) {
      throw new APIError('Brazilian Hyundai force refresh did not return fresh data in time; vehicle may be unreachable.');
    }
    return getChildValue(response, 'resMsg.state.Vehicle');
  }

  async odometer(token, vehicleConfig) {
    const state = await this.updateVehicleWithCachedState(token, vehicleConfig);
    return { value: getChildValue(state, 'Drivetrain.Odometer') };
  }

  // PUT /user/pin, like Type1 — but with BR's own header block, and its own
  // expiry bookkeeping (Type1 caches seconds-since-epoch on the token).
  async _ensureControlToken(token) {
    if (token.controlToken && token.controlTokenExpiry - 5 > Date.now() / 1000) {
      return token.controlToken;
    }
    if (!token.pin) throw new APIError('PIN is required for remote commands.');

    const deviceId = token.deviceId || await this._ensureDeviceId();
    token.deviceId = deviceId;

    const response = await this.session.putJsonExpectJson(this._apiUrl('/user/pin'), {
      pin: token.pin,
      deviceId,
    }, { headers: this._getAuthenticatedHeaders(token) });

    if (!response.controlToken) throw new APIError('Failed to obtain control token.');
    token.controlToken = `Bearer ${response.controlToken}`;
    token.controlTokenExpiry = Math.floor(Date.now() / 1000 + (Number(response.expiresTime) || 600));
    return token.controlToken;
  }

  // BR answers 200 with retCode 'N' on a rejected command, so the shared
  // checkResponseForErrors is not enough on its own for these.
  _commandResult(response, what) {
    if (response.retCode !== 'S') {
      throw new APIError(`${what} failed: ${response.resCode} ${JSON.stringify(response.resMsg)}`);
    }
    return response.msgId;
  }

  async lockAction(token, vehicleConfig, action) {
    const url = this._apiV2Url(`spa/vehicles/${vehicleConfig.id}/control/door`);
    const headers = await this._commandHeaders(token, vehicleConfig);
    const response = await this.session.postJsonExpectJson(url, {
      deviceId: headers['ccsp-device-id'],
      action,
    }, { headers });
    return this._commandResult(response, 'Lock action');
  }

  // BR drives every window together, so any closed window in the request
  // makes it a close — upstream's rule, kept verbatim.
  async setWindowsState(token, vehicleConfig, options = {}) {
    const url = this._apiV2Url(`spa/vehicles/${vehicleConfig.id}/control/window`);
    const anyClosed = [options.frontLeft, options.frontRight, options.backLeft, options.backRight]
      .some((state) => state === WINDOW_STATE.CLOSED);
    const headers = await this._commandHeaders(token, vehicleConfig);
    const response = await this.session.postJsonExpectJson(url, {
      action: anyClosed ? 'close' : 'open',
      deviceId: headers['ccsp-device-id'],
    }, { headers });
    return this._commandResult(response, 'Window action');
  }

  // Lights only — BR has no horn variant, so the combined flash-and-honk
  // command maps onto the same endpoint.
  async startHazardLights(token, vehicleConfig) {
    const url = this._apiV2Url(`spa/vehicles/${vehicleConfig.id}/control/light`);
    const headers = await this._commandHeaders(token, vehicleConfig);
    const response = await this.session.postJsonExpectJson(url, {}, { headers });
    return this._commandResult(response, 'Hazard lights');
  }

  async startHazardLightsAndHorn(token, vehicleConfig) {
    return this.startHazardLights(token, vehicleConfig);
  }

  async startClimate(token, vehicleConfig, options = {}) {
    const url = this._apiV2Url(`spa/vehicles/${vehicleConfig.id}/control/engine`);
    const setTemp = options.setTemp ?? 21;
    const duration = options.duration ?? 10;
    const defrost = options.defrost ?? false;
    const climate = options.climate ?? true;
    const heating = options.heating ?? 0;
    const headers = await this._commandHeaders(token, vehicleConfig);
    // BR indexes the hex temp table by the plain Celsius value, not by a
    // position in temperatureRange like every other region.
    const response = await this.session.postJsonExpectJson(url, {
      action: 'start',
      options: {
        airCtrl: climate ? 1 : 0,
        heating1: Number(heating),
        seatHeaterVentCMD: { drvSeatOptCmd: options.frontLeftSeat || 0 },
        defrost,
        igniOnDuration: duration,
      },
      hvacType: 1,
      deviceId: headers['ccsp-device-id'],
      tempCode: getIndexIntoHexTemp(Math.trunc(setTemp)),
      unit: 'C',
    }, { headers });
    return this._commandResult(response, 'Start climate');
  }

  async stopClimate(token, vehicleConfig) {
    const url = this._apiV2Url(`spa/vehicles/${vehicleConfig.id}/control/engine`);
    const headers = await this._commandHeaders(token, vehicleConfig);
    const response = await this.session.postJsonExpectJson(url, {
      action: 'stop',
      deviceId: headers['ccsp-device-id'],
    }, { headers });
    return this._commandResult(response, 'Stop climate');
  }

  // Not offered by the BR backend (upstream sets supports_valet_mode = False).
  async valetModeAction() {
    throw new APIError('Valet mode is not supported in Brazil.');
  }

}

module.exports = HyundaiBlueLinkApiBR;
