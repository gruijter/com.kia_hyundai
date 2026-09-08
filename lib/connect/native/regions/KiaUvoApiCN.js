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

// Port of KiaUvoApiCN.py as rewritten upstream in 2026-09 (#1295, v4.28.0).
// Upstream reverse-engineered it from the China Bluelink iOS app 5.05
// (build 103, live build 109) and verified it end-to-end against
// prd.cn-ccapi.hyundai.com with a real account; the Kia constants come from
// the same binary but only the Hyundai side is live-verified. Everything
// upstream marks CN-UNVERIFIED is marked the same way here.
//
// The previous port never worked: it carried a stale API surface and died on
// the very first call (`/spa/notifications/register` -> 400 resCode 4002,
// reproduced live 2026-09-08 for both brands). What changed:
//
//   1. LOGIN — completely replaced. The authorization code is now issued for
//      the UARS service (uars-{k|h}.hmgmobility.com.cn), whose callback
//      redeems it SERVER-SIDE and returns the whole token bundle embedded in
//      an HTML page. The old /api/v1/user/oauth2/token exchange is dead
//      (errCode 4002) and is gone, along with BASIC_AUTHORIZATION — whose
//      Hyundai value decoded to the placeholder "<id>:secret".
//   2. DEVICE REGISTRATION — pushType GCM -> APNS, and providerDeviceId is
//      mandatory (a fresh uuid, not the hardcoded one the old port sent).
//   3. APP_IDs — the old ones (eea8762c… Kia, ed01581a… Hyundai) no longer
//      exist in the current app.
//   4. TOKENS — the access token lives 6h (expiresIn 21600), not the fictional
//      30 days; refresh goes through /user/silentsignin (session cookie, no
//      password) instead of a refresh_token grant.
//   5. HEADERS — no Stamp (EU-only), and the CN app's own User-Agent.
//
// The business surface (vehicles / status / location / control paths) is
// unchanged from the old implementation and was re-verified upstream, so it
// is carried over here as-is.
//
// Same deliberate deviation as the other regions: raw JSON instead of a
// Vehicle dataclass, normalized to { vehicleStatus, vehicleLocation }. See
// ../../NAMING.md.

const crypto = require('crypto');
const { ApiImplType1, checkResponseForErrors, retryOnDeviceIdError } = require('../ApiImplType1');
const Token = require('../Token');
const {
  BRAND_KIA, BRAND_HYUNDAI, VEHICLE_LOCK_ACTION, CHARGE_PORT_ACTION,
} = require('../const');
const { getChildValue, getIndexIntoHexTemp, nearestRangeIndex } = require('../utils');
const { APIError, AuthenticationError } = require('../exceptions');
const { prefixLogger } = require('../logger');

// Live-app User-Agent (build 109, 2026-08). The China app is native iOS /
// NSURLSession — the okhttp UA the other regions send never belonged here.
const USER_AGENT_BLUELINK_CN = 'BlueLink/109 CFNetwork/3896.100.1.2.1 Darwin/27.0.0';

// The car may have to wake up to get a GPS fix; upstream measured >30s, well
// past the shared 30s default.
const LOCATION_TIMEOUT_MS = 90 * 1000;
const LOGIN_TIMEOUT_MS = 60 * 1000;

// Port of _extract_uars_login_bundle: loginCallback.do embeds the token
// bundle in a JS template literal — var x = `{"code":0,...,"data":{...}}`.
// Returns the parsed top-level JSON, whose `data` member carries the tokens.
function extractUarsLoginBundle(html) {
  // Preferred: the template-literal form (live-verified upstream).
  const literals = html.matchAll(/=\s*`(\{[\s\S]*?\})\s*`/g);
  for (const match of literals) {
    try {
      const candidate = JSON.parse(match[1]);
      if (candidate?.data?.uarsToken) return candidate;
    } catch {
      // not JSON after all — keep scanning
    }
  }
  // Fallback: brace-matched scan around any "uarsToken" key, walking outward
  // from the nearest "{" so both the bare data object and the full wrapper
  // are recognised (normalised to { data } on return).
  for (const keyMatch of html.matchAll(/"uarsToken"/g)) {
    const keyAt = keyMatch.index;
    const openPositions = [];
    for (let i = 0; i <= keyAt; i += 1) if (html[i] === '{') openPositions.push(i);
    for (const start of openPositions.reverse()) {
      let depth = 0;
      for (let idx = start; idx < html.length; idx += 1) {
        if (html[idx] === '{') depth += 1;
        else if (html[idx] === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              const candidate = JSON.parse(html.slice(start, idx + 1));
              if (candidate?.data?.uarsToken) return candidate;
              if (candidate?.uarsToken) return { data: candidate };
            } catch {
              // not a JSON object — try the next enclosing brace
            }
            break;
          }
        }
      }
    }
  }
  throw new AuthenticationError('UARS login callback did not return a token bundle. '
    + 'The session may have expired — please retry the login.');
}

class KiaUvoApiCN extends ApiImplType1 {

  constructor(region, brand, language, { logger } = {}) {
    super({ logger: prefixLogger(logger, 'KiaUvoApiCN') });
    this.dataTimezone = 'Asia/Shanghai';
    // Python: tuple(x * 0.5 for x in range(28, 60)) -> 14.0 .. 29.5
    this.temperatureRange = Array.from({ length: 32 }, (_, i) => (28 + i) * 0.5);
    this.brand = brand;
    this.LANGUAGE = language || 'zh';

    // CN-UNVERIFIED: the Kia constants come from the same app binary
    // (NetworkDefines) but only the Hyundai side has been live-verified.
    if (brand === BRAND_KIA) {
      this.BASE_DOMAIN = 'prd.cn-ccapi.kia.com';
      this.UARS_DOMAIN = 'uars-k.hmgmobility.com.cn';
      this.CCSP_SERVICE_ID = '9d5df92a-06ae-435f-b459-8304f2efcc67';
      this.APP_ID = '5519a969-295f-4c5a-a27e-9d9fab2bd50c';
    } else if (brand === BRAND_HYUNDAI) {
      this.BASE_DOMAIN = 'prd.cn-ccapi.hyundai.com';
      this.UARS_DOMAIN = 'uars-h.hmgmobility.com.cn';
      this.CCSP_SERVICE_ID = '72b3d019-5bc7-443d-a437-08f307cf06e2';
      this.APP_ID = 'b09e4d17-c30c-40f1-a1ec-8ac11d6665cf';
    } else {
      throw new Error(`Unsupported brand for KiaUvoApiCN: ${brand}`);
    }

    this.BASE_URL = this.BASE_DOMAIN;
    this.USER_API_URL = `https://${this.BASE_URL}/api/v1/user/`;
    this.SPA_API_URL = `https://${this.BASE_URL}/api/v1/spa/`;
    this.SPA_API_URL_V2 = `https://${this.BASE_URL}/api/v2/spa/`;
    this.LOGIN_API_URL = `https://${this.BASE_URL}/web/v1/user/`;
    this.UARS_BASE_URL = `https://${this.UARS_DOMAIN}`;
    this.CLIENT_ID = this.CCSP_SERVICE_ID;

    // Per-username UARS state (uarsToken / tokenCode / profile). Kept off the
    // Token object because that one is shared across all regions. Nothing
    // reads it yet — it exists for the UARS-side features (PIN reset page,
    // WeChat binding), exactly as upstream keeps it.
    this._uarsState = {};

    [
      'updateVehicleWithCachedState', 'forceRefreshVehicleState', 'lockAction',
      'chargePortAction', 'startClimate', 'stopClimate', 'startCharge', 'stopCharge',
      'setChargeLimits',
    ].forEach((name) => {
      this[name] = retryOnDeviceIdError(this[name]).bind(this);
    });
  }

  // China does not use the Stamp header (EU-only). Present so the inherited
  // retry-on-device-id wrapper keeps working.
  _getStamp() {
    return '';
  }

  _getAuthenticatedHeaders(token, ccs2Support) {
    const headers = {
      Authorization: token.accessToken,
      'ccsp-service-id': this.CCSP_SERVICE_ID,
      'ccsp-application-id': this.APP_ID,
      // Without this the servers answer resCode 4002 "deviceId is not exist".
      'ccsp-device-id': token.deviceId,
      Host: this.BASE_URL,
      Connection: 'Keep-Alive',
      'Accept-Encoding': 'gzip',
      'User-Agent': USER_AGENT_BLUELINK_CN,
    };
    if (ccs2Support !== undefined && ccs2Support !== null) {
      headers.Ccuccs2protocolsupport = String(ccs2Support);
    }
    return headers;
  }

  // CN-UNVERIFIED upstream: the /api/v1/user/pin path is confirmed present in
  // the current login-page bundle, the response keys are carried over from the
  // old code. Note the URL has no "?token=" here, unlike the Type1 base.
  async _getControlToken(token) {
    if (token.controlToken && token.controlTokenExpiry > Date.now() / 1000) {
      return token.controlToken;
    }
    if (!token.pin) {
      throw new APIError('A PIN is required for remote control actions on China accounts.');
    }
    const response = await this.session.putJsonExpectJson(`${this.USER_API_URL}pin`, {
      deviceId: token.deviceId,
      pin: token.pin,
    }, {
      headers: {
        Authorization: token.accessToken,
        'ccsp-service-id': this.CCSP_SERVICE_ID,
        'ccsp-application-id': this.APP_ID,
        'ccsp-device-id': token.deviceId,
        'Content-type': 'application/json',
        Host: this.BASE_URL,
        'Accept-Encoding': 'gzip',
        'User-Agent': USER_AGENT_BLUELINK_CN,
      },
    });
    if (!response.controlToken) {
      throw new APIError('PIN verification failed, ensure PIN is entered correctly.');
    }
    token.controlToken = `Bearer ${response.controlToken}`;
    token.controlTokenExpiry = Math.floor(Date.now() / 1000 + (Number(response.expiresTime) || 0));
    return token.controlToken;
  }

  // pushType APNS (the China app uses APNs + Alibaba push, not GCM) and a
  // mandatory providerDeviceId — without it the server answers resCode 4002.
  async _getDeviceId() {
    const url = `${this.SPA_API_URL}notifications/register`;
    const payload = {
      providerDeviceId: crypto.randomUUID(),
      pushRegId: crypto.randomUUID().replace(/-/g, ''),
      pushType: 'APNS',
      uuid: crypto.randomUUID(),
    };
    const headers = {
      'ccsp-service-id': this.CCSP_SERVICE_ID,
      'ccsp-application-id': this.APP_ID,
      'Content-Type': 'application/json;charset=UTF-8',
      Host: this.BASE_URL,
      Connection: 'Keep-Alive',
      'Accept-Encoding': 'gzip',
      'User-Agent': USER_AGENT_BLUELINK_CN,
    };
    const response = await this.session.postJsonExpectJson(url, payload, { headers });
    if (response.retCode === 'F') {
      throw new APIError(`Device registration failed: ${JSON.stringify(response.resMsg)}`);
    }
    return response.resMsg.deviceId;
  }

  // The base64url `state` blob the UARS callback expects.
  static _uarsStateParam(deviceUuid, interfaceId) {
    const blob = {
      interfaceId, accUnqNo: '', deviceUuid, webRedirect: '',
    };
    return Buffer.from(JSON.stringify(blob)).toString('base64url').replace(/=+$/, '');
  }

  // Follow the UARS loginCallback.do redirect and harvest the tokens: the
  // UARS server performs the OAuth code exchange itself and returns the
  // bundle inside the response HTML.
  async _exchangeUarsCallback(redirectUrl) {
    const response = await this.session.get(redirectUrl, {
      headers: { 'User-Agent': USER_AGENT_BLUELINK_CN },
      timeout: LOGIN_TIMEOUT_MS,
    });
    if (response.status >= 400) {
      throw new AuthenticationError(`UARS login callback failed with HTTP ${response.status}`);
    }
    return extractUarsLoginBundle(await response.text());
  }

  // Five-step flow; see the header comment for how it differs from the dead
  // one. Note this spans two hosts (ccapi + UARS) and depends on the session
  // cookies set along the way — ApiImplSession keeps one jar for all hosts,
  // which is what makes that work here.
  async login(username, password, pin) {
    const deviceUuid = crypto.randomUUID().toUpperCase();

    // Step 1: bootstrap the UARS web session (302s into the authorize flow).
    await this.session.get(
      `${this.UARS_BASE_URL}/join/account/loginInit.do?cocd=H&deviceUuid=${deviceUuid}&redirect=`,
      { headers: { 'User-Agent': USER_AGENT_BLUELINK_CN }, timeout: LOGIN_TIMEOUT_MS },
    );

    // Step 2: authorize with the UARS callback as redirect_uri. This is the
    // single most important difference from the old implementation — the
    // resulting code belongs to the UARS service, NOT to
    // /api/v1/user/oauth2/token (which is why the old flow got errCode 4002).
    const state = KiaUvoApiCN._uarsStateParam(deviceUuid, 'UARS-COM-040');
    await this.session.get(
      `https://${this.BASE_URL}/api/v1/user/oauth2/authorize?response_type=code`
      + `&client_id=${this.CCSP_SERVICE_ID}`
      + `&redirect_uri=${this.UARS_BASE_URL}%2Fjoin%2Fccsp%2FloginCallback.do`
      + `&state=${state}&lang=${this.LANGUAGE}&scope=url.login`,
      { headers: { 'User-Agent': USER_AGENT_BLUELINK_CN }, timeout: LOGIN_TIMEOUT_MS },
    );

    // Step 3: credentials. `mobileNum` is new but the app always sends it
    // (an empty string is accepted).
    const signin = await this.session.postJson(`https://${this.BASE_URL}/api/v1/user/signin`, {
      email: username,
      password,
      mobileNum: '',
    }, {
      headers: {
        'ccsp-service-id': this.CCSP_SERVICE_ID,
        'ccsp-application-id': this.APP_ID,
        'User-Agent': USER_AGENT_BLUELINK_CN,
      },
      timeout: LOGIN_TIMEOUT_MS,
    });
    if (signin.status >= 400) throw new AuthenticationError(`Login failed: HTTP ${signin.status}`);
    const { redirectUrl } = await signin.json();
    if (!redirectUrl) {
      throw new AuthenticationError('Login failed: no redirectUrl in signin response '
        + '(check credentials, or the account requires SMS/WeChat login)');
    }

    // Step 4: the UARS server redeems the code and hands back the tokens.
    const { data } = await this._exchangeUarsCallback(redirectUrl);
    const { ccspToken } = data;

    // Step 5: register this "device" for the ccsp-device-id business header.
    const deviceId = await this._getDeviceId();

    this._uarsState[username] = {
      uarsToken: data.uarsToken,
      tokenCode: data.tokenCode,
      profile: data.profile || {},
    };

    // The old 30-day LOGIN_TOKEN_LIFETIME was fiction — the real access token
    // lives 6 hours, so validUntil follows the server value.
    const expiresIn = Number(ccspToken.expiresIn) || 21600;
    return new Token({
      username,
      password,
      pin,
      accessToken: `${ccspToken.tokenType || 'Bearer'} ${ccspToken.accessToken}`,
      refreshToken: ccspToken.refresh_token || ccspToken.refreshToken,
      deviceId,
      validUntil: new Date(Date.now() + expiresIn * 1000),
    });
  }

  // The oauth2/token refresh_token grant is dead on the current servers
  // (errCode 4002). Instead the ccapi session cookie mints a fresh UARS
  // callback code via /user/silentsignin, with no password. Falls back to a
  // full login once that cookie has expired — no worse than before.
  async refreshAccessToken(token) {
    try {
      const response = await this.session.postJson(`https://${this.BASE_URL}/api/v1/user/silentsignin`, {
        intUserId: '',
      }, {
        headers: {
          'ccsp-service-id': this.CCSP_SERVICE_ID,
          'ccsp-application-id': this.APP_ID,
          'User-Agent': USER_AGENT_BLUELINK_CN,
        },
        timeout: LOGIN_TIMEOUT_MS,
      });
      if (response.status >= 400) throw new APIError(`silentsignin HTTP ${response.status}`);
      const { redirectUrl } = await response.json();
      if (!redirectUrl) throw new APIError('silentsignin returned no redirectUrl');

      const { data } = await this._exchangeUarsCallback(redirectUrl);
      const { ccspToken } = data;
      const expiresIn = Number(ccspToken.expiresIn) || 21600;
      if (this._uarsState[token.username]) {
        this._uarsState[token.username] = {
          uarsToken: data.uarsToken,
          tokenCode: data.tokenCode,
          profile: data.profile || {},
        };
      }
      const refreshed = new Token({
        username: token.username,
        password: token.password,
        pin: token.pin,
        accessToken: `${ccspToken.tokenType || 'Bearer'} ${ccspToken.accessToken}`,
        refreshToken: ccspToken.refresh_token || ccspToken.refreshToken,
        deviceId: token.deviceId,
        validUntil: new Date(Date.now() + expiresIn * 1000),
      });
      // Carried over rather than passed to the constructor: Token only takes
      // these as fields, and a still-valid control token survives a refresh.
      refreshed.controlToken = token.controlToken;
      refreshed.controlTokenExpiry = token.controlTokenExpiry;
      return refreshed;
    } catch (error) {
      this.logger.log(`refreshAccessToken: silent refresh failed (${error.message}), falling back to full login`);
    }
    if (token.password) return this.login(token.username, token.password, token.pin);
    throw new AuthenticationError('Token refresh failed and no stored password is available.');
  }

  async getVehicles(token) {
    const url = `${this.SPA_API_URL}vehicles`;
    const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
    checkResponseForErrors(response);
    return response.resMsg.vehicles.map((entry) => ({
      ...entry,
      id: entry.vehicleId,
      name: entry.vehicleName,
      // The China vehicle list doesn't include ccuCCS2ProtocolSupport
      // (verified upstream on a 2025 Custo) — default to 0 so the legacy
      // status path is used.
      ccuCCS2ProtocolSupport: entry.ccuCCS2ProtocolSupport ?? 0,
    }));
  }

  // CN wraps the cached status one level deeper than the other regions
  // (resMsg.status.time / .odometer / .engine), hence the unwrap here.
  async updateVehicleWithCachedState(token, vehicleConfig) {
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/status/latest`;
    const response = await this.session.getJson(url, {
      headers: this._getAuthenticatedHeaders(token),
      timeout: LOGIN_TIMEOUT_MS,
    });
    checkResponseForErrors(response);
    const raw = response.resMsg || {};
    return KiaUvoApiCN._normalizeStatus(raw.status, raw.vehicleLocation);
  }

  // CN's resMsg wraps the flat status as { status, vehicleLocation }
  // (upstream reads "status.time" / "status.odometer.value" straight off
  // it), so unwrapping .status puts `time` where device.js#mapStatus()
  // expects it. The odometer sits inside that status, but mapStatus() reads
  // it one level up next to vehicleStatus — the way EU's
  // resMsg.vehicleStatusInfo already delivers it — so hoist it here, or
  // measure_odo never gets a value.
  static _normalizeStatus(status, location) {
    return {
      vehicleStatus: status,
      vehicleLocation: location,
      odometer: status?.odometer,
    };
  }

  async forceRefreshVehicleState(token, vehicleConfig) {
    if (vehicleConfig.ccuCCS2ProtocolSupport) {
      // CN-UNVERIFIED upstream: no CCS2 vehicle in the test account; the path
      // mirrors EU and the /ccs2 strings found in the China app binary.
      const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/ccs2/carstatus/latest`;
      const response = await this.session.getJson(url, {
        headers: this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport),
        timeout: LOCATION_TIMEOUT_MS,
      });
      checkResponseForErrors(response);
      const location = await this.getLocation(token, vehicleConfig);
      return KiaUvoApiCN._normalizeStatus(response.resMsg?.status, location);
    }
    // CN-UNVERIFIED upstream: legacy force-refresh path, presumed intact (the
    // cached /status/latest endpoint is the verified one).
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/status`;
    const response = await this.session.getJson(url, {
      headers: this._getAuthenticatedHeaders(token),
      timeout: LOCATION_TIMEOUT_MS,
    });
    checkResponseForErrors(response);
    const location = await this.getLocation(token, vehicleConfig);
    return KiaUvoApiCN._normalizeStatus(response.resMsg, location);
  }

  async getLocation(token, vehicleConfig) {
    try {
      const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/location`;
      const response = await this.session.getJson(url, {
        headers: this._getAuthenticatedHeaders(token),
        timeout: LOCATION_TIMEOUT_MS,
      });
      checkResponseForErrors(response);
      return response.resMsg;
    } catch {
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
    const payload = {
      action: 'start',
      hvacType: 1,
      options: { defrost, heating1: Number(heating) },
      tempCode: getIndexIntoHexTemp(nearestRangeIndex(this.temperatureRange, setTemp)),
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

  // CN-UNVERIFIED upstream: the app also exposes a per-current limit
  // (/ccs2/charge/chargingcurrent); the legacy targetSOClist endpoint is kept
  // until an EV can confirm.
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

}

module.exports = KiaUvoApiCN;
