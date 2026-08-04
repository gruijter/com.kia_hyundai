'use strict';

// Poort van KiaUvoApiCN.py. CN wijkt sterk af van de ApiImplType1-basis: geen
// Stamp-header, geen ccs2/non-ccs2-onderscheid in de control-acties (altijd
// dezelfde endpoints), en een login-flow met TWEE sequentiële OAuth-calls
// (authorization_code -> refresh_token grant met het net ontvangen refresh
// token, wat de "refresh_token" in de Token wordt). Overschrijft daarom bijna
// alle ApiImplType1-methodes i.p.v. de EU/AU-stijl gedeeltelijke hergebruik.
//
// Zelfde bewuste afwijking als de andere regio's: raw JSON i.p.v. Vehicle-
// dataclass, genormaliseerd naar { vehicleStatus, vehicleLocation }. Zie
// ../../NAMING.md.

const crypto = require('crypto');
const { ApiImplSession, USER_AGENT_OK_HTTP } = require('../http');
const { ApiImplType1, checkResponseForErrors, retryOnDeviceIdError } = require('../ApiImplType1');
const Token = require('../Token');
const {
  BRAND_KIA, BRAND_HYUNDAI, VEHICLE_LOCK_ACTION, CHARGE_PORT_ACTION,
} = require('../const');
const { getChildValue, getIndexIntoHexTemp } = require('../utils');
const { AuthenticationError } = require('../exceptions');
const { prefixLogger } = require('../logger');

class KiaUvoApiCN extends ApiImplType1 {
  constructor(region, brand, language, { logger } = {}) {
    super();
    this.logger = prefixLogger(logger, 'KiaUvoApiCN');
    this.dataTimezone = 'Asia/Shanghai';
    this.temperatureRange = Array.from({ length: 32 }, (_, i) => (28 + i) * 0.5);
    this.brand = brand;
    this.LANGUAGE = language;

    if (brand === BRAND_KIA) {
      this.BASE_DOMAIN = 'prd.cn-ccapi.kia.com';
      this.CCSP_SERVICE_ID = '9d5df92a-06ae-435f-b459-8304f2efcc67';
      this.APP_ID = 'eea8762c-adfc-4ee4-8d7a-6e2452ddf342';
      this.BASIC_AUTHORIZATION = 'Basic OWQ1ZGY5MmEtMDZhZS00MzVmLWI0NTktODMwNGYyZWZjYzY3OnRzWGRrVWcwOEF2MlpaelhPZ1d6Snl4VVQ2eWVTbk5OUWtYWFBSZEtXRUFOd2wxcA==';
    } else if (brand === BRAND_HYUNDAI) {
      this.BASE_DOMAIN = 'prd.cn-ccapi.hyundai.com';
      this.CCSP_SERVICE_ID = '72b3d019-5bc7-443d-a437-08f307cf06e2';
      this.APP_ID = 'ed01581a-380f-48cd-83d4-ed1490c272d0';
      this.BASIC_AUTHORIZATION = 'Basic NzJiM2QwMTktNWJjNy00NDNkLWE0MzctMDhmMzA3Y2YwNmUyOnNlY3JldA==';
    } else {
      throw new Error(`Unsupported brand for KiaUvoApiCN: ${brand}`);
    }

    this.BASE_URL = this.BASE_DOMAIN;
    this.USER_API_URL = `https://${this.BASE_URL}/api/v1/user/`;
    this.SPA_API_URL = `https://${this.BASE_URL}/api/v1/spa/`;
    this.SPA_API_URL_V2 = `https://${this.BASE_URL}/api/v2/spa/`;
    this.CLIENT_ID = this.CCSP_SERVICE_ID;
    this.session = new ApiImplSession({ logger: this.logger });

    [
      'updateVehicleWithCachedState', 'forceRefreshVehicleState', 'lockAction',
      'chargePortAction', 'startClimate', 'stopClimate', 'startCharge', 'stopCharge',
      'setChargeLimits',
    ].forEach((name) => {
      this[name] = retryOnDeviceIdError(this[name]).bind(this);
    });
  }

  // CN heeft geen Stamp-header, in tegenstelling tot de andere Type1-regio's.
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
    const deviceId = await this._getDeviceId();
    const cookies = await this._getCookies();
    await this._setSessionLanguage(cookies);

    let authorizationCode;
    try {
      authorizationCode = await this._getAuthorizationCodeWithRedirectUrl(username, password, cookies);
    } catch (error) {
      authorizationCode = null;
    }
    if (!authorizationCode) throw new AuthenticationError('Login Failed');

    const [, accessToken, refreshExchangeCode] = await this._getAccessToken(authorizationCode);
    const [, refreshToken] = await this._getRefreshToken(refreshExchangeCode);
    const validUntil = new Date(Date.now() + 23 * 60 * 60 * 1000); // LOGIN_TOKEN_LIFETIME

    return new Token({
      username, password, pin, accessToken, refreshToken, deviceId, validUntil,
    });
  }

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

  // CN maakt geen onderscheid tussen ccs2/non-ccs2 voor de gecachete status.
  async updateVehicleWithCachedState(token, vehicleConfig) {
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/status/latest`;
    const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    const raw = response.resMsg || {};
    return { vehicleStatus: raw.status, vehicleLocation: raw.vehicleLocation };
  }

  async forceRefreshVehicleState(token, vehicleConfig) {
    if (vehicleConfig.ccuCCS2ProtocolSupport) {
      const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/ccs2/carstatus`;
      const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
      checkResponseForErrors(response);
      const location = await this.getLocation(token, vehicleConfig);
      return { vehicleStatus: response.resMsg?.status, vehicleLocation: location };
    }
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/status`;
    const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    const location = await this.getLocation(token, vehicleConfig);
    return { vehicleStatus: response.resMsg, vehicleLocation: location };
  }

  async getLocation(token, vehicleConfig) {
    try {
      const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/location`;
      const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
      checkResponseForErrors(response);
      return response.resMsg;
    } catch (error) {
      return null;
    }
  }

  async odometer(token, vehicleConfig) {
    const state = await this.updateVehicleWithCachedState(token, vehicleConfig);
    return getChildValue(state, 'vehicleStatus.odometer');
  }

  async lockAction(token, vehicleConfig, action) {
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/control/door`;
    const payload = { action: action === VEHICLE_LOCK_ACTION.LOCK ? 'close' : 'open', deviceId: token.deviceId };
    const response = await this.session.postJsonExpectJson(url, payload, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async chargePortAction(token, vehicleConfig, action) {
    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/control/portdoor`;
    const payload = { action: action === CHARGE_PORT_ACTION.OPEN ? 'open' : 'close', deviceId: token.deviceId };
    const response = await this.session.postJsonExpectJson(url, payload, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async startClimate(token, vehicleConfig, options = {}) {
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/control/engine`;
    const setTemp = options.setTemp ?? 21;
    const defrost = options.defrost ?? false;
    const heating = options.heating ?? 0;
    const hexSetTemp = getIndexIntoHexTemp(this.temperatureRange.indexOf(setTemp));
    const payload = {
      action: 'start',
      hvacType: 1,
      options: { defrost, heating1: Number(heating) },
      tempCode: hexSetTemp,
      unit: 'C',
    };
    const response = await this.session.postJsonExpectJson(url, payload, { headers: this._getAuthenticatedHeaders(token) });
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

  async startCharge(token, vehicleConfig) {
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/control/charge`;
    const payload = { action: 'start', deviceId: token.deviceId };
    const response = await this.session.postJsonExpectJson(url, payload, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async stopCharge(token, vehicleConfig) {
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/control/charge`;
    const payload = { action: 'stop', deviceId: token.deviceId };
    const response = await this.session.postJsonExpectJson(url, payload, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async setChargeLimits(token, vehicleConfig, ac, dc) {
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/charge/target`;
    const body = {
      targetSOClist: [
        { plugType: 0, targetSOClevel: Number(dc) },
        { plugType: 1, targetSOClevel: Number(ac) },
      ],
    };
    const response = await this.session.postJsonExpectJson(url, body, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    return response.msgId;
  }

  async _getDeviceId() {
    const url = `${this.SPA_API_URL}notifications/register`;
    const payload = {
      providerDeviceId: '59af09e554a9442ab8589c9500d04d2e',
      pushRegId: '1',
      pushType: 'GCM',
      uuid: crypto.randomUUID(),
    };
    const headers = {
      'ccsp-service-id': this.CLIENT_ID,
      'ccsp-application-id': this.APP_ID,
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
      + `&redirect_uri=https://${this.BASE_URL}:443/api/v1/user/oauth2/redirect&lang=`;
    const session = new ApiImplSession({ logger: this.logger });
    await session.get(url);
    return Object.fromEntries(session.cookies);
  }

  async _setSessionLanguage(cookies) {
    await this.session.postJson(this.USER_API_URL, { lang: 'zh' }, { cookies });
  }

  async _getAuthorizationCodeWithRedirectUrl(username, password, cookies) {
    const url = `${this.USER_API_URL}signin`;
    const response = await this.session.postJsonExpectJson(url, { email: username, password }, { cookies });
    const redirectUrl = new URL(response.redirectUrl);
    return redirectUrl.searchParams.get('code');
  }

  async _getAccessToken(authorizationCode) {
    const url = `${this.USER_API_URL}oauth2/token`;
    const headers = {
      Authorization: this.BASIC_AUTHORIZATION,
      Host: this.BASE_URL,
      Connection: 'close',
      'Accept-Encoding': 'gzip, deflate',
    };
    const response = await this.session.postFormExpectJson(url, {
      grant_type: 'authorization_code',
      redirect_uri: `https://${this.BASE_DOMAIN}:443/api/v1/user/oauth2/redirect`,
      code: authorizationCode,
    }, { headers });
    const tokenType = response.token_type;
    const accessToken = `${tokenType} ${response.access_token}`;
    // Upstream gebruikt hier bewust het refresh_token uit deze respons als
    // input voor een TWEEDE oauth2/token-call (_get_refresh_token) — geen
    // rechtstreekse refresh_token-grant zoals de andere regio's.
    return [tokenType, accessToken, response.refresh_token];
  }

  async _getRefreshToken(authorizationCode) {
    const url = `${this.USER_API_URL}oauth2/token`;
    const headers = {
      Authorization: this.BASIC_AUTHORIZATION,
      Host: this.BASE_URL,
      Connection: 'close',
      'Accept-Encoding': 'gzip, deflate',
    };
    const response = await this.session.postFormExpectJson(url, {
      grant_type: 'refresh_token',
      redirect_uri: 'https://www.getpostman.com/oauth2/callback',
      refresh_token: authorizationCode,
    }, { headers });
    const tokenType = response.token_type;
    // Upstream slaat hier bewust "<token_type> <access_token>" op als het
    // refresh_token-veld van de Token (geen typfout — zie KiaUvoApiCN.py).
    const refreshToken = `${tokenType} ${response.access_token}`;
    return [tokenType, refreshToken];
  }
}

module.exports = KiaUvoApiCN;
