'use strict';

// Port of KiaUvoApiAU.py. Covers Kia AU, Hyundai AU, and Kia NZ (like
// upstream: same class, brand+region determine the endpoints). Simpler
// login flow than EU: no RSA encryption, just a JSON POST with email/password.
//
// Same deliberate deviation as KiaUvoApiEU.js: updateVehicleWithCachedState/
// forceRefreshVehicleState return raw JSON instead of mutating a Vehicle
// dataclass — normalized to the same { vehicleStatus, vehicleLocation,
// odometer } shape as EU (upstream AU itself uses the key "status" instead
// of "vehicleStatus"; converted here so device.js#mapStatus() works
// unchanged across all regions). See ../../NAMING.md.

const crypto = require('crypto');
const { ApiImplSession, USER_AGENT_OK_HTTP } = require('../http');
const { ApiImplType1, checkResponseForErrors, retryOnDeviceIdError } = require('../ApiImplType1');
const Token = require('../Token');
const { BRAND_KIA, BRAND_HYUNDAI, REGION_AUSTRALIA } = require('../const');
const { xorStamp, getChildValue } = require('../utils');
const { AuthenticationError } = require('../exceptions');
const { prefixLogger } = require('../logger');

class KiaUvoApiAU extends ApiImplType1 {
  constructor(region, brand, language, { logger } = {}) {
    super();
    this.logger = prefixLogger(logger, 'KiaUvoApiAU');
    this.dataTimezone = 'Australia/Sydney';
    // equivalent to Python's tuple(x * 0.5 for x in range(34, 54)) -> 17.0..26.5
    this.temperatureRange = Array.from({ length: 20 }, (_, i) => (34 + i) * 0.5);
    this.brand = brand;
    this.LANGUAGE = language;

    if (brand === BRAND_KIA && region === REGION_AUSTRALIA) {
      this.BASE_URL = 'au-apigw.ccs.kia.com.au:8082';
      this.CCSP_SERVICE_ID = '8acb778a-b918-4a8d-8624-73a0beb64289';
      this.APP_ID = '4ad4dcde-be23-48a8-bc1c-91b94f5c06f8';
      this.BASIC_AUTHORIZATION = 'Basic OGFjYjc3OGEtYjkxOC00YThkLTg2MjQtNzNhMGJlYjY0Mjg5OjdTY01NbTZmRVlYZGlFUEN4YVBhUW1nZVlkbFVyZndvaDRBZlhHT3pZSVMyQ3U5VA==';
      this.cfb = Buffer.from('SGGCDRvrzmRa2WTNFQPUaNfSFdtPklZ48xUuVckigYasxmeOQqVgCAC++YNrI1vVabI=', 'base64');
    } else if (brand === BRAND_HYUNDAI) {
      this.BASE_URL = 'au-apigw.ccs.hyundai.com.au:8080';
      this.CCSP_SERVICE_ID = '855c72df-dfd7-4230-ab03-67cbf902bb1c';
      this.APP_ID = 'f9ccfdac-a48d-4c57-bd32-9116963c24ed';
      this.BASIC_AUTHORIZATION = 'Basic ODU1YzcyZGYtZGZkNy00MjMwLWFiMDMtNjdjYmY5MDJiYjFjOmU2ZmJ3SE0zMllOYmhRbDBwdmlhUHAzcmY0dDNTNms5MWVjZUEzTUpMZGJkVGhDTw==';
      this.cfb = Buffer.from('nGDHng3k4Cg9gWV+C+A6Yk/ecDopUNTkGmDpr2qVKAQXx9bvY2/YLoHPfObliK32mZQ=', 'base64');
    } else {
      // Kia NZ (REGION_NZ) — the only other combination upstream supports
      this.BASE_URL = 'au-apigw.ccs.kia.com.au:8082';
      this.CCSP_SERVICE_ID = '4ab606a7-cea4-48a0-a216-ed9c14a4a38c';
      this.APP_ID = '97745337-cac6-4a5b-afc3-e65ace81c994';
      this.BASIC_AUTHORIZATION = 'Basic NGFiNjA2YTctY2VhNC00OGEwLWEyMTYtZWQ5YzE0YTRhMzhjOjBoYUZxWFRrS2t0Tktmemt4aFowYWt1MzFpNzRnMHlRRm01b2QybXo0TGRJNW1MWQ==';
      this.cfb = Buffer.from('SGGCDRvrzmRa2WTNFQPUaC1OsnAhQgPgcQETEfbY8abEjR/ICXK0p+Rayw5tHCGyiUA=', 'base64');
    }

    this.USER_API_URL = `https://${this.BASE_URL}/api/v1/user/`;
    this.SPA_API_URL = `https://${this.BASE_URL}/api/v1/spa/`;
    this.SPA_API_URL_V2 = `https://${this.BASE_URL}/api/v2/spa/`;
    this.CLIENT_ID = this.CCSP_SERVICE_ID;
    this.session = new ApiImplSession({ logger: this.logger });

    [
      'updateVehicleWithCachedState', 'forceRefreshVehicleState', 'chargePortAction',
    ].forEach((name) => {
      this[name] = retryOnDeviceIdError(this[name]).bind(this);
    });
  }

  async login(username, password, pin) {
    const stamp = this._getStamp();
    const deviceId = await this._getDeviceId(stamp);
    const cookies = await this._getCookies();

    let authorizationCode;
    try {
      authorizationCode = await this._getAuthorizationCodeWithRedirectUrl(username, password, cookies);
    } catch (error) {
      authorizationCode = null;
    }
    if (!authorizationCode) throw new AuthenticationError('Login Failed');

    const [, accessToken, refreshToken, expiresIn] = await this._getAccessToken(authorizationCode, stamp);
    const validUntil = expiresIn
      ? new Date(Date.now() + Number(expiresIn) * 1000)
      : new Date(Date.now() + 23 * 60 * 60 * 1000); // LOGIN_TOKEN_LIFETIME fallback

    return new Token({
      username, password, pin, accessToken, refreshToken, deviceId, validUntil,
    });
  }

  async updateVehicleWithCachedState(token, vehicleConfig) {
    const isCcs2 = !!vehicleConfig.ccuCCS2ProtocolSupport;
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}${isCcs2 ? '/ccs2/carstatus/latest' : '/status/latest'}`;
    const response = await this.session.getJson(url, {
      headers: this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport),
    });
    checkResponseForErrors(response);

    if (isCcs2) {
      const state = response.resMsg.state.Vehicle;
      const location = await this.getLocation(token, vehicleConfig);
      if (location && getChildValue(location, 'coord.lat') !== undefined) {
        state.Location = state.Location || {};
        state.Location.GeoCoord = state.Location.GeoCoord || {};
        state.Location.GeoCoord.Latitude = location.coord.lat;
        state.Location.GeoCoord.Longitude = location.coord.lon;
      }
      return state;
    }
    const location = await this.getLocation(token, vehicleConfig);
    return {
      vehicleStatus: response.resMsg,
      vehicleLocation: location,
    };
  }

  async forceRefreshVehicleState(token, vehicleConfig) {
    if (vehicleConfig.ccuCCS2ProtocolSupport) {
      const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/ccs2/carstatus`;
      const response = await this.session.getJson(url, {
        headers: this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport),
      });
      checkResponseForErrors(response);
      const state = response.resMsg.state.Vehicle;
      const location = await this.getLocation(token, vehicleConfig);
      if (location && getChildValue(location, 'coord.lat') !== undefined) {
        state.Location = state.Location || {};
        state.Location.GeoCoord = state.Location.GeoCoord || {};
        state.Location.GeoCoord.Latitude = location.coord.lat;
        state.Location.GeoCoord.Longitude = location.coord.lon;
      }
      return state;
    }
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/status`;
    const response = await this.session.getJson(url, {
      headers: this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport),
    });
    checkResponseForErrors(response);
    const location = await this.getLocation(token, vehicleConfig);
    return { vehicleStatus: response.resMsg, vehicleLocation: location };
  }

  async getLocation(token, vehicleConfig) {
    try {
      const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/location/park`;
      const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
      checkResponseForErrors(response);
      return response.resMsg;
    } catch (error) {
      return null;
    }
  }

  async odometer(token, vehicleConfig) {
    const state = await this.updateVehicleWithCachedState(token, vehicleConfig);
    if (vehicleConfig.ccuCCS2ProtocolSupport) {
      return { value: getChildValue(state, 'Drivetrain.Odometer') };
    }
    return getChildValue(state, 'vehicleStatus.odometer') || getChildValue(state, 'vehicleStatus.dte');
  }

  async chargePortAction(token, vehicleConfig, action) {
    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/control/portdoor`;
    const payload = { action: action === 'open' ? 'open' : 'close', deviceId: token.deviceId };
    const response = await this.session.postJsonExpectJson(url, payload, {
      headers: await this._getControlHeaders(token, vehicleConfig),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  // Australia is always RHD, regardless of the odometer unit.
  _getDrvSeatLoc() {
    return 'R';
  }

  _getStamp() {
    return xorStamp(this.cfb, this.APP_ID);
  }

  async _getDeviceId(stamp) {
    const registrationId = crypto.randomBytes(32).toString('hex');
    const url = `${this.SPA_API_URL}notifications/register`;
    const payload = { pushRegId: registrationId, pushType: 'GCM', uuid: crypto.randomUUID() };
    const headers = {
      'ccsp-service-id': this.CLIENT_ID,
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
    const url = `${this.USER_API_URL}oauth2/authorize?response_type=code&client_id=${this.CLIENT_ID}`
      + `&redirect_uri=https://${this.BASE_URL}/api/v1/user/oauth2/redirect&lang=en`;
    const session = new ApiImplSession({ logger: this.logger });
    await session.get(url);
    return Object.fromEntries(session.cookies);
  }

  async _getAuthorizationCodeWithRedirectUrl(username, password, cookies) {
    const url = `${this.USER_API_URL}signin`;
    const response = await this.session.postJsonExpectJson(url, { email: username, password }, { cookies });
    const redirectUrl = new URL(response.redirectUrl);
    return redirectUrl.searchParams.get('code');
  }

  async _getAccessToken(authorizationCode, stamp) {
    const url = `${this.USER_API_URL}oauth2/token`;
    const headers = {
      Authorization: this.BASIC_AUTHORIZATION,
      Stamp: stamp,
      Host: this.BASE_URL,
      Connection: 'close',
      'Accept-Encoding': 'gzip, deflate',
    };
    const response = await this.session.postFormExpectJson(url, {
      grant_type: 'authorization_code',
      redirect_uri: `https://${this.BASE_URL}/api/v1/user/oauth2/redirect`,
      code: authorizationCode,
    }, { headers });
    checkResponseForErrors(response);
    const tokenType = response.token_type;
    const accessToken = `${tokenType} ${response.access_token}`;
    // Refresh token stays verbatim: the refresh_token grant rejects a
    // "Bearer " prefix or an access-token-instead-of-refresh-token (kia_uvo #1778).
    const refreshToken = response.refresh_token;
    const expiresIn = response.expires_in;
    return [tokenType, accessToken, refreshToken, expiresIn];
  }

  // AU requires the Stamp header on the refresh_token grant.
  _refreshAccessTokenHeaders() {
    return { Stamp: this._getStamp() };
  }
}

module.exports = KiaUvoApiAU;
