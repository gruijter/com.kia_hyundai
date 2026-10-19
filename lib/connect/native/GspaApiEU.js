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

// Port of GspaApiEU.py — shared EU GSPA base: the OneApp (CCI) login flow and
// the GSPA secure-request layer (X-Stamp). Brand subclasses
// (regions/KiaCciApiEU.js, regions/HyundaiCciApiEU.js) provide the brand
// constants. Ported so far: login, token lifecycle, vehicle list, X-Stamp
// headers, GSPA GET, stored-status, prewakeup, the control layer (PIN
// control token, command POST, action-status polling), every command,
// schedules and OTA. Not ported: the CCS2 Vehicle parser (see ../NAMING.md)
// and SVM (needs upstream's svm.py).
//
// Brand constants live on the prototype (Object.assign below each class),
// not in class fields: the base constructor reads them, and subclass class
// fields are only set after super() returns.
//
// The CCI login steps duplicate KiaUvoApiEU.js#_loginWithPasswordCci on
// purpose: upstream keeps them as two copies too, and fixes land in either.

const crypto = require('crypto');
const { ApiImplSession, USER_AGENT_OK_HTTP } = require('./http');
const ApiImpl = require('./ApiImpl');
const Token = require('./Token');
const {
  ENGINE_TYPES, ORDER_STATUS, VEHICLE_LOCK_ACTION, CHARGE_PORT_ACTION, VALET_MODE_ACTION, WINDOW_STATE,
} = require('./const');
const { formatScheduleTime, pyFixed1, pyRound } = require('./utils');
const {
  APIError, AuthenticationError, ConsentRequiredError, DuplicateRequestError,
  InvalidAPIResponseError, ServiceTemporaryUnavailable, UnsupportedControlError,
} = require('./exceptions');
const { prefixLogger } = require('./logger');
const {
  buildFpHeaders, clientNameForBrand, computeXFingerprint, isGateRejection,
} = require('./cciFingerprint');
const { createTsid, hyundaiCipher, kiaCipher } = require('./gspa/cipherKeys');

const USER_AGENT_MOZILLA = 'Mozilla/5.0 (Linux; Android 4.1.1; Galaxy Nexus Build/JRO03C) AppleWebKit/535.19 (KHTML, like Gecko) Chrome/18.0.1025.166 Mobile Safari/535.19';

const SUPPORTED_LANGUAGES_LIST = ['en', 'de', 'fr', 'it', 'es', 'sv', 'nl', 'no', 'cs', 'sk', 'hu', 'da', 'pl', 'fi', 'pt'];

// Python's dict.get(key, default): the default only when the key is absent.
const dictGet = (obj, key, dflt) => (obj && typeof obj === 'object' && key in obj ? obj[key] : dflt);

// Python's `is not None`.
const isSet = (v) => v !== undefined && v !== null;

// Wall-clock parts of `date` in `timeZone`; weekday Sun=0.
function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
  };
}

// UTC offset of `timeZone` at `date`, in ms (local = UTC + offset).
function zoneOffsetMs(date, timeZone) {
  const tz = new Date(date.toLocaleString('en-US', { timeZone })).getTime();
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  return tz - utc;
}

class GspaApiEU extends ApiImpl {
  get CCI_DOMAIN_API_URL() {
    return `${this.CCI_API_URL}/domain/api/`;
  }

  constructor(region, brand, language, { logger } = {}) {
    super();
    this.logger = prefixLogger(logger, this.constructor.name);

    let lang = (language || 'en').toLowerCase();
    if (lang.length > 2) lang = lang.slice(0, 2);
    if (!SUPPORTED_LANGUAGES_LIST.includes(lang)) {
      this.logger.log(`Unsupported language: ${lang}, fallback to en`);
      lang = 'en';
    }

    this.region = region;
    this.LANGUAGE = lang;
    this.brand = brand;

    this._cciClientName = String(this.brand).toLowerCase();
    this._cciClientVersion = '1.3.3';
    this._cciClientOsVersion = '18.7';
    this._cciNotificationProvider = 'APNS';

    this.CCSP_API_URL = this.GSPA_BASE_URL.replace(/\/+$/, '');
    if (this.CIPHER_BRAND === 'hyundai') {
      this._cipher = hyundaiCipher();
    } else if (this.CIPHER_BRAND === 'kia') {
      this._cipher = kiaCipher();
    } else {
      throw new APIError(`Unknown cipher brand: ${this.CIPHER_BRAND}`);
    }

    // Control token caching lives on the Token (controlToken /
    // controlTokenExpiry), the same pattern as ApiImplType1.

    this.session = new ApiImplSession({ logger: this.logger });
  }

  // Upstream sends every CCI/GSPA call as a bare requests.get/post, i.e.
  // without a Session and so without a cookie jar. A fresh ApiImplSession
  // per call is the same; reusing this.session would replay one host's
  // Set-Cookie to the other (its jar is shared across hosts, see http.js).
  _requests() {
    return new ApiImplSession({ logger: this.logger });
  }

  // Login via the CCI flow and return a Token with all CCI fields.
  // Generates a local deviceId (UUID), runs the CCI password login,
  // registers the device on CCI, and extracts the CCS user id for the GSPA
  // X-Stamp.
  async login(username, password, pin) {
    const deviceId = crypto.randomUUID();

    const loginResult = await this._loginWithPassword(username, password, deviceId);

    const token = new Token({
      username,
      password,
      accessToken: loginResult.accessToken,
      refreshToken: loginResult.refreshToken,
      deviceId,
      validUntil: loginResult.validUntil,
      pin,
      cciAccessToken: loginResult.cciAccessToken,
      exchangeableToken: loginResult.exchangeableToken,
      exchangeableRefreshToken: loginResult.exchangeableRefreshToken,
      nonCcsToken: loginResult.nonCcsToken,
      nonCcsRefreshToken: loginResult.nonCcsRefreshToken,
      idToken: loginResult.idToken,
    });

    // Register device on CCI (non-critical — best effort).
    await this._registerDevice(token);

    // Extract CCS user id for the GSPA X-Stamp (best effort).
    this._fetchUserId(token);

    return token;
  }

  // CCI password login (OneApp client_id, bypasses the IDPConnect WAF).
  // 1. authorize (OneApp client_id, not WAF-blocked)
  // 2. certs (RSA JWK for password encryption)
  // 3. signin (RSA-encrypted password, state=ccsp)
  // 4. token (auth code -> CCI tokens)
  // 5. token-exchange (CCI -> CCS token)
  async _loginWithPassword(username, password, deviceId) {
    const host = this.LOGIN_FORM_HOST;
    const clientId = this.ONEAPP_CLIENT_ID;
    const redirectUri = this.ONEAPP_REDIRECT_URI;
    const mobileUa = `${USER_AGENT_MOZILLA}_CCS_APP_AOS`;

    const s = new ApiImplSession({ logger: this.logger });
    const baseHeaders = { 'User-Agent': mobileUa };

    // Step 1: authorize
    const authUrl = `${host}/auth/api/v2/user/oauth2/authorize?response_type=code&client_id=${clientId}`
      + `&redirect_uri=${redirectUri}&lang=en&state=ccsp&country=de`;
    const authResp = await s.get(authUrl, { headers: baseHeaders });
    const authText = await authResp.text().catch(() => '');
    if (authText.toLowerCase().includes('abusing') || (authResp.url || '').includes('/error?status=400')) {
      throw new AuthenticationError("IDPConnect authorize was blocked by the WAF ('abusing request'). This is a server-side block, not a credentials problem. See #1273.");
    }

    // Step 2: RSA public key
    const certsResp = await s.get(`${host}/auth/api/v1/accounts/certs`, { headers: baseHeaders });
    if (certsResp.status !== 200) {
      throw new AuthenticationError(`API error: failed to fetch RSA certs: HTTP ${certsResp.status}. This may indicate an API change.`);
    }
    const jwk = dictGet(await certsResp.json(), 'retValue', {});
    const kid = jwk.kid || '';
    if (!jwk.n || !jwk.e) {
      throw new AuthenticationError('API error: certs response missing RSA key material');
    }
    const key = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    const encryptedPw = crypto.publicEncrypt(
      { key, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(password, 'utf8'),
    ).toString('hex');

    // Step 3: signin with RSA-encrypted password
    const resp = await s.postForm(`${host}/auth/account/signin`, {
      client_id: clientId,
      encryptedPassword: 'true',
      password: encryptedPw,
      redirect_uri: redirectUri,
      scope: '',
      nonce: '',
      state: 'ccsp',
      username,
      connector_session_key: '',
      kid,
      _csrf: '',
    }, { headers: baseHeaders, redirect: 'manual' });
    if (resp.status !== 302) {
      const text = await resp.text().catch(() => '');
      throw new AuthenticationError(`Signin failed: HTTP ${resp.status} — ${text.slice(0, 300)}. Check username and password.`);
    }
    const location = resp.headers.get('location') || '';
    const query = new URL(location, host).searchParams;
    const code = query.get('code');
    if (!code) {
      if (location.toLowerCase().includes('error')) {
        const errorDesc = query.get('error_description') || 'unknown';
        throw new AuthenticationError(`Authentication rejected: ${errorDesc}. Check username and password.`);
      }
      if (location.includes('/web/v1/user/authorization')) {
        throw new ConsentRequiredError('Account consent is required. Please log in via a browser once to accept the terms, then retry.');
      }
      if (location.includes('authorize')) {
        throw new AuthenticationError('Authentication failed — returned to login page. Check username and password.');
      }
      throw new AuthenticationError(`API error: unexpected redirect after signin: ${location.slice(0, 250)}`);
    }

    // Step 4: exchange auth code for CCI tokens
    const cci = await this._exchangeAuthCodeForCciTokens(deviceId, code);
    const cciAccessToken = dictGet(cci, 'accessToken', '');
    const cciRefreshToken = dictGet(cci, 'refreshToken', '');
    const nonCcsToken = dictGet(cci, 'nonCcsToken', '');
    const exchangeableToken = dictGet(cci, 'exchangeableAccessToken', '');
    const exchangeableRefreshToken = dictGet(cci, 'exchangeableRefreshToken', '');
    const nonCcsRefreshToken = dictGet(cci, 'nonCcsRefreshToken', '');
    const idToken = dictGet(cci, 'idToken', '');
    const cciExpiresIn = Number(dictGet(cci, 'expiresIn', 3599));

    // Step 5: exchange CCI token for CCS token
    const { ccsToken, ccsValidUntil } = await this._exchangeCcsToken(deviceId, cciAccessToken, nonCcsToken, exchangeableToken);

    return {
      accessToken: `Bearer ${ccsToken}`,
      refreshToken: cciRefreshToken,
      expiresIn: cciExpiresIn,
      validUntil: ccsValidUntil,
      cciAccessToken,
      exchangeableToken,
      exchangeableRefreshToken,
      nonCcsToken,
      nonCcsRefreshToken,
      idToken,
    };
  }

  // POST the auth code for CCI tokens, primary path per brand. All EU OneApp
  // auth endpoints are fingerprint-gated (2026-10-14): /auth/v1/token with
  // the signed X-Fingerprint identity headers goes first; the legacy
  // domain/api exchange runs as fallback so a gate rollback keeps working.
  async _exchangeAuthCodeForCciTokens(deviceId, authCode) {
    let resp = await this._fpExchangeAuthCode(deviceId, authCode);
    let text = await resp.clone().text().catch(() => '');
    if (resp.status !== 200 && isGateRejection(resp.status, text)) {
      this.logger.error(`Fingerprint gate rejected the signed auth-code exchange (HTTP ${resp.status}); fell back to the legacy route`);
      resp = await this._legacyExchangeAuthCode(deviceId, authCode);
      text = await resp.clone().text().catch(() => '');
    }
    if (resp.status !== 200) {
      throw new AuthenticationError(`CCI token exchange failed: HTTP ${resp.status} — ${text.slice(0, 200)}. This may indicate an API change.`);
    }
    return resp.json();
  }

  // POST code to the legacy domain/api exchange (no fingerprint).
  _legacyExchangeAuthCode(deviceId, authCode) {
    const s = new ApiImplSession({ logger: this.logger });
    return s.request('POST', `${this.CCI_DOMAIN_API_URL}v1/auth/token?code=${encodeURIComponent(authCode)}`, {
      headers: this._getCciHeaders(deviceId),
    });
  }

  // POST code to the fingerprint-gated /auth/v1/token exchange.
  _fpExchangeAuthCode(deviceId, authCode) {
    const s = new ApiImplSession({ logger: this.logger });
    return s.request('POST', `${this.CCI_API_URL}/auth/v1/token?code=${encodeURIComponent(authCode)}`, {
      headers: this._cciFpHeaders(deviceId),
    });
  }

  // ------------------------------------------------------------------
  // CCI headers
  // ------------------------------------------------------------------

  // Current UTC offset of dataTimezone as '+HH:MM'.
  _cciTimezoneOffset() {
    const now = new Date();
    const tzMs = new Date(now.toLocaleString('en-US', { timeZone: this.dataTimezone })).getTime();
    const utcMs = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
    const offsetMinutes = Math.round((tzMs - utcMs) / 60000);
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  }

  // Header set for the fingerprint-gated CCI endpoints. The gate validates
  // the X-Fingerprint HMAC against the client identity in these headers, so
  // this uses the OneApp build identity (cciFingerprint constants), not the
  // legacy CCI header values. Pass the exact request body so the signature
  // covers it.
  _cciFpHeaders(deviceId, body = '') {
    const headers = buildFpHeaders({
      packageId: this.CCI_PACKAGE_ID,
      clientName: clientNameForBrand(this.brand),
      deviceId,
      locale: this.LANGUAGE,
      timezone: this._cciTimezoneOffset(),
      brandLabel: this.brand,
    });
    headers['X-Timestamp'] = String(Date.now());
    headers['X-Fingerprint'] = computeXFingerprint(headers, this.brand, body);
    return headers;
  }

  // Headers for the CCI API.
  _getCciHeaders(deviceId, {
    cciAccessToken, nonCcsToken, exchangeableToken, contentType,
  } = {}) {
    const headers = {
      'client-id': this.CCI_PACKAGE_ID,
      'client-name': this._cciClientName,
      'client-version': this._cciClientVersion,
      'client-os-code': 'ios',
      'client-os-version': this._cciClientOsVersion,
      'client-device-id': deviceId || '',
      'client-device-model': 'iPhone',
      'client-notification-provider-type': this._cciNotificationProvider,
      locale: this.LANGUAGE.toUpperCase(),
      timezone: this._cciTimezoneOffset(),
      Accept: 'application/json',
      'Accept-Language': this.LANGUAGE,
      'User-Agent': USER_AGENT_OK_HTTP,
    };
    if (nonCcsToken !== undefined && nonCcsToken !== null) headers.Authentication = nonCcsToken;
    if (cciAccessToken !== undefined && cciAccessToken !== null) {
      headers.authorization = `Bearer ${cciAccessToken.replace(/^Bearer /, '').trim()}`;
    }
    if (exchangeableToken !== undefined && exchangeableToken !== null) {
      headers['exchangeable-token'] = exchangeableToken;
      headers['non-ccs-token'] = nonCcsToken || '';
    }
    if (contentType) headers['Content-Type'] = contentType;
    else headers['Content-Length'] = '0';
    return headers;
  }

  _cciTokenHeaders(token, contentType) {
    return this._getCciHeaders(token.deviceId || '', {
      cciAccessToken: token.cciAccessToken,
      nonCcsToken: token.nonCcsToken,
      exchangeableToken: token.exchangeableToken,
      contentType,
    });
  }

  // ------------------------------------------------------------------
  // Vehicle list
  // ------------------------------------------------------------------

  // Get the list of vehicles from CCI (cci-api-eu, no CCAPI fallback). Both
  // brands use the same available-vehicles endpoint shape (ccspCarId /
  // ccspVehicle.carId envelope), so the fetch and parser are shared.
  async getVehicles(token) {
    const url = `${this.CCI_DOMAIN_API_URL}v1/vehicle/available-vehicles?detail=true`;
    const response = await this._requests().get(url, { headers: this._cciTokenHeaders(token) });
    const text = await response.text();
    if (response.status !== 200) {
      throw new APIError(`CCI get_vehicles failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
    }
    return this._parseVehiclesFromCci(JSON.parse(text));
  }

  // Returns plain vehicleConfig objects (the raw entry plus the fields
  // upstream puts on its Vehicle), like every other region here.
  _parseVehiclesFromCci(data) {
    const vehicles = [];
    let vehicleList = Array.isArray(data)
      ? data
      : dictGet(data, 'contents', dictGet(data, 'vehicles', []));
    if (vehicleList && !Array.isArray(vehicleList) && typeof vehicleList === 'object') vehicleList = [vehicleList];

    (vehicleList || []).forEach((entry) => {
      const ccsp = dictGet(entry, 'ccspVehicle', {});
      const vehicleId = entry.ccspCarId
        || (ccsp ? ccsp.carId : null)
        || dictGet(entry, 'vehicleId', '');
      let ccs2Support = dictGet(entry, 'ccs2ProtocolSupport', dictGet(entry, 'ccu_ccs2_protocol_support', 0));
      if (!ccs2Support) {
        const isCcs = dictGet(entry, 'isCcs', false);
        const isCcsOpen = dictGet(entry, 'isCcsOpen', false);
        if (isCcs && isCcsOpen) ccs2Support = 2;
      }

      const carType = (ccsp ? ccsp.carType : '') || '';
      const isEv = dictGet(entry, 'isEv', false);
      const fuelType = dictGet(entry, 'fuelType', dictGet(entry, 'engineFuelCode', ''));
      let entryEngineType;
      if (isEv || fuelType === 'EV' || ['EV', 'ELEC'].includes(carType)) {
        entryEngineType = ENGINE_TYPES.EV;
      } else if (['PHEV', 'HEV+PHEV'].includes(fuelType) || ['PHEV'].includes(carType)) {
        entryEngineType = ENGINE_TYPES.PHEV;
      } else if (fuelType === 'HEV' || ['HEV', 'HV'].includes(carType)) {
        entryEngineType = ENGINE_TYPES.HEV;
      } else {
        entryEngineType = ENGINE_TYPES.ICE;
      }

      vehicles.push({
        ...entry,
        id: vehicleId,
        name: dictGet(entry, 'vehicleNameView', dictGet(entry, 'nickname', dictGet(entry, 'vehicleName', ''))),
        model: dictGet(entry, 'vehicleModelName', dictGet(entry, 'modelName', '')),
        vin: dictGet(entry, 'vin', ''),
        engineType: entryEngineType,
        ccuCCS2ProtocolSupport: ccs2Support,
      });
    });

    return vehicles;
  }

  // ------------------------------------------------------------------
  // CCS token exchange
  // ------------------------------------------------------------------

  // Exchange a CCI access token for a CCS token (token-exchange?serviceType=CCS).
  // Fingerprint-gated like the other /auth endpoints (unsigned calls answer
  // 9035): the signed primary carries the CCI token headers on the OneApp
  // identity, the legacy domain/api route runs unsigned as fallback. The
  // CCS token is accepted by GSPA REST endpoints.
  async _exchangeCcsToken(deviceId, cciAccessToken, nonCcsToken, exchangeableToken) {
    let headers = this._cciFpHeaders(deviceId);
    headers.authorization = `Bearer ${(cciAccessToken || '').replace(/^Bearer /, '').trim()}`;
    headers.Authentication = nonCcsToken || '';
    if (exchangeableToken) {
      headers['exchangeable-token'] = exchangeableToken;
      headers['non-ccs-token'] = nonCcsToken || '';
    }
    let s = new ApiImplSession({ logger: this.logger });
    let resp = await s.request('POST', `${this.CCI_API_URL}/auth/v1/token-exchange?serviceType=CCS`, { headers });
    let text = await resp.text().catch(() => '');
    if (resp.status !== 200 && isGateRejection(resp.status, text)) {
      this.logger.error(`Fingerprint gate rejected the signed CCS token-exchange (HTTP ${resp.status}); fell back to the legacy route`);
      headers = this._getCciHeaders(deviceId, { cciAccessToken, nonCcsToken, exchangeableToken });
      s = new ApiImplSession({ logger: this.logger });
      resp = await s.request('POST', `${this.CCI_DOMAIN_API_URL}v1/auth/token-exchange?serviceType=CCS`, { headers });
      text = await resp.text().catch(() => '');
    }
    if (resp.status !== 200) {
      throw new AuthenticationError(`CCS token exchange failed: HTTP ${resp.status} — ${text.slice(0, 200)}. This may indicate an API change.`);
    }
    const data = JSON.parse(text);
    const ccsToken = data.accessToken || data.ccsAccessToken || '';
    if (!ccsToken) {
      throw new AuthenticationError(`CCS token exchange returned no accessToken: ${text.slice(0, 200)}`);
    }
    // expiresTime is the CCS token TTL in seconds (e.g. 86400 = 24h), not an
    // epoch. Treat it as a relative duration from now; fall back to +1h.
    // Upstream's int(expires_in) raises on a non-numeric value; without this
    // check Number() would give NaN, an Invalid Date, and a token that never
    // counts as expired.
    const expiresIn = data.expiresTime;
    let ccsValidUntil;
    if (expiresIn) {
      const seconds = Math.trunc(Number(expiresIn));
      if (!Number.isFinite(seconds)) {
        throw new InvalidAPIResponseError(`CCS token exchange returned a non-numeric expiresTime: ${expiresIn}`);
      }
      ccsValidUntil = new Date(Date.now() + seconds * 1000);
    } else {
      ccsValidUntil = new Date(Date.now() + 3600 * 1000);
    }
    return { ccsToken, ccsValidUntil };
  }

  // ------------------------------------------------------------------
  // Device registration (CCI)
  // ------------------------------------------------------------------

  // Register the device on CCI for push notifications.
  // POST /domain/api/v3/notifications/bases/devices
  // - appToken: sha256(deviceId) — stable across requests
  // - deviceToken: deviceId (stable UUID)
  async _registerDevice(token) {
    const url = `${this.CCI_DOMAIN_API_URL}v3/notifications/bases/devices`;
    const headers = this._cciTokenHeaders(token, 'application/json');
    const deviceId = token.deviceId || '';
    const body = {
      appToken: crypto.createHash('sha256').update(deviceId).digest('hex'),
      deviceModel: 'iPhone',
      deviceAppVer: this._cciClientVersion,
      deviceOsVer: this._cciClientOsVersion,
      deviceToken: deviceId,
    };
    try {
      const response = await this._requests().postJson(url, body, { headers });
      if (response.status !== 200) {
        this.logger.log(`Device registration failed: HTTP ${response.status} (non-critical)`);
      }
    } catch {
      this.logger.log('Device registration failed (non-critical)');
    }
  }

  // ------------------------------------------------------------------
  // CCS user-id extraction (for GSPA X-Stamp)
  // ------------------------------------------------------------------

  // Populate token.userId for the GSPA X-Stamp. The X-Stamp payload needs
  // the 'uid' claim from the CCS token JWT. Fallback chain:
  // 1. 'uid' from the CCS token JWT (primary)
  // 2. 'sub' from the id_token JWT (fallback)
  _fetchUserId(token) {
    if (token.userId) return;

    // The CCS token is stored as accessToken (with "Bearer " prefix)
    const ccsToken = (token.accessToken || '').replace(/^Bearer /, '');
    if (ccsToken) {
      const uid = GspaApiEU._extractJwtClaim(ccsToken, 'uid');
      if (uid) {
        token.userId = uid;
        return;
      }
    }

    if (token.idToken) {
      const sub = GspaApiEU._extractJwtClaim(token.idToken, 'sub');
      if (sub) token.userId = sub;
    }
  }

  // Extract a claim from a JWT without verification.
  static _extractJwtClaim(jwtToken, claim) {
    if (!jwtToken) return null;
    const parts = jwtToken.replace(/^Bearer /, '').split('.');
    if (parts.length < 2) return null;
    try {
      const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))[claim];
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Token refresh
  // ------------------------------------------------------------------

  // Refresh the access token using the stored CCI token set: POST
  // v2/auth/token-refresh with the full token set, then re-exchange the CCS
  // token. Falls back to a full login if the refresh fails.
  async refreshAccessToken(token) {
    if (token.cciAccessToken || token.nonCcsToken) {
      try {
        return await this._refreshCciToken(token);
      } catch (ex) {
        if (String(ex.message).includes('4111')) {
          // 4111 = credentials expired; the refresh token itself is expired.
          // Full login is the expected recovery.
          this.logger.log('CCI credentials expired (4111), falling back to full login');
        } else {
          this.logger.error(`CCI token refresh failed (${ex.message}), falling back to full login`);
        }
        return this.login(token.username, token.password, token.pin);
      }
    }

    // No CCI tokens — fall back to full login
    return this.login(token.username, token.password, token.pin);
  }

  // Refresh the CCI token set and re-exchange the CCS token. POST
  // /auth/v2/token-refresh signed with X-Fingerprint over the exact body
  // bytes; the legacy domain/api v2+JSON route runs as fallback.
  async _refreshCciToken(token) {
    const deviceId = token.deviceId || '';
    const body = {
      accessToken: (token.cciAccessToken || '').replace(/^Bearer /, ''),
      refreshToken: token.refreshToken || '',
      exchangeableAccessToken: token.exchangeableToken || '',
      exchangeableRefreshToken: token.exchangeableRefreshToken || '',
      nonCcsToken: token.nonCcsToken || '',
      nonCcsRefreshToken: token.nonCcsRefreshToken || '',
      idToken: token.idToken || '',
    };
    const payload = JSON.stringify(body);
    let headers = this._cciFpHeaders(deviceId, payload);
    headers['Content-Type'] = 'application/json';
    let s = new ApiImplSession({ logger: this.logger });
    let resp = await s.request('POST', `${this.CCI_API_URL}/auth/v2/token-refresh`, { headers, body: payload });
    let text = await resp.clone().text().catch(() => '');
    if (resp.status !== 200 && isGateRejection(resp.status, text)) {
      this.logger.error(`Fingerprint gate rejected the signed token refresh (HTTP ${resp.status}); fell back to the legacy route`);
      headers = this._cciTokenHeaders(token, 'application/json');
      s = new ApiImplSession({ logger: this.logger });
      resp = await s.postJson(`${this.CCI_DOMAIN_API_URL}v2/auth/token-refresh`, body, { headers });
      text = await resp.clone().text().catch(() => '');
    }
    if (resp.status !== 200) {
      throw new AuthenticationError(`CCI token refresh failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    const cciAccessToken = dictGet(data, 'accessToken', token.cciAccessToken || '');
    const cciRefreshToken = dictGet(data, 'refreshToken', token.refreshToken || '');
    const nonCcsToken = dictGet(data, 'nonCcsToken', token.nonCcsToken || '');
    let exchangeableToken = dictGet(data, 'exchangeableAccessToken', token.exchangeableToken || '');
    const exchangeableRefreshToken = dictGet(data, 'exchangeableRefreshToken', token.exchangeableRefreshToken || '');
    const nonCcsRefreshToken = dictGet(data, 'nonCcsRefreshToken', token.nonCcsRefreshToken || '');
    const idToken = dictGet(data, 'idToken', token.idToken || '');

    // set-cookie t= may carry an updated exchangeable token
    const setCookie = resp.headers.get('set-cookie') || '';
    if (setCookie.includes('t=')) {
      const m = setCookie.match(/(?:^|;\s*)t=([^;]+)/);
      if (m && m[1]) exchangeableToken = m[1];
    }

    // Re-exchange the CCS token
    const { ccsToken, ccsValidUntil } = await this._exchangeCcsToken(deviceId, cciAccessToken, nonCcsToken, exchangeableToken);

    return new Token({
      username: token.username,
      password: token.password,
      accessToken: `Bearer ${ccsToken}`,
      refreshToken: cciRefreshToken,
      deviceId: token.deviceId,
      validUntil: ccsValidUntil,
      pin: token.pin,
      cciAccessToken,
      exchangeableToken,
      exchangeableRefreshToken,
      nonCcsToken,
      nonCcsRefreshToken,
      idToken,
      userId: token.userId,
    });
  }

  // ------------------------------------------------------------------
  // Token test
  // ------------------------------------------------------------------

  // Test whether the CCS token is still valid via the CCI API.
  async testToken(token) {
    const url = `${this.CCI_DOMAIN_API_URL}v1/vehicle/available-vehicles?detail=false`;
    try {
      const response = await this._requests().get(url, { headers: this._cciTokenHeaders(token) });
      return response.status === 200;
    } catch {
      this.logger.log('CCS token freshness check failed');
      return false;
    }
  }

  // ------------------------------------------------------------------
  // GSPA X-Stamp computation
  // ------------------------------------------------------------------

  // Compute the GSPA X-Stamp + tsid for GSPA endpoint authentication.
  // Returns [stamp, tsid] — sent as X-Stamp + X-Request-Id headers; the
  // server validates the stamp against the tsid.
  _getStamp(token) {
    try {
      const deviceId = (token.deviceId || '').replace(/-/g, '');
      const tsid = createTsid(deviceId);
      const epochSeconds = Math.floor(Date.now() / 1000);
      const userId = token.userId || '';
      const stamp = this._cipher.computeXStamp(this.STAMP_REGION, tsid, epochSeconds, userId);
      return [stamp, tsid];
    } catch (e) {
      throw new APIError(`X-Stamp computation failed: ${e.message}`);
    }
  }

  // ------------------------------------------------------------------
  // GSPA authenticated headers
  // ------------------------------------------------------------------

  // Headers for GSPA REST endpoints on the brand GSPA host.
  _getAuthenticatedHeaders(token, ccs2Support = 0) {
    const ccsToken = (token.accessToken || '').replace(/^Bearer /, '');
    const headers = {
      Authorization: `Bearer ${ccsToken}`,
      'ccsp-service-id': this.CCSP_SERVICE_ID,
      'ccsp-application-id': this.CCSP_SERVICE_ID,
      'ccsp-device-id': token.deviceId || '',
      [this.DEVICE_ID_HEADER]: token.deviceId || '',
      Ccuccs2protocolsupport: String(ccs2Support),
      'client-id': this.ONEAPP_CLIENT_ID,
      'client-name': this._cciClientName,
      'client-version': this._cciClientVersion,
      'client-os-code': 'AOS',
      'client-os-version': '14',
      Language: this.LANGUAGE,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT_OK_HTTP,
    };
    const [stamp, tsid] = this._getStamp(token);
    headers['X-Stamp'] = stamp;
    headers[this.REQUEST_ID_HEADER] = tsid;
    return headers;
  }

  // Ensure the CCS token is still valid for GSPA requests. The token stores
  // the CCS token as accessToken and its expiry as validUntil; an expired
  // token raises AuthenticationError so the caller can refresh.
  _validateCcsToken(token) {
    if (!token.accessToken) throw new AuthenticationError('No CCS token — cannot make GSPA request');
    const { validUntil } = token;
    if (!(validUntil instanceof Date)) return;
    if (validUntil.getTime() - 60 * 1000 <= Date.now()) {
      throw new AuthenticationError('CCS token expired — refresh required');
    }
  }

  // Raise a typed exception from a GSPA failure response.
  //   401                       -> AuthenticationError
  //   "400-004"/"4004"          -> DuplicateRequestError (queued duplicate)
  //   resCode "403-*"           -> AuthenticationError (stamp/auth failure)
  //   "no update info" in msg   -> APIError (no pending OTA — business state)
  //   resCode "404-*"           -> UnsupportedControlError
  //   5xx HTTP / resCode "5-*"  -> ServiceTemporaryUnavailable
  //   else                      -> APIError with the raw server message
  // Handles three shapes: the control-command envelope ({rc, msg}), the
  // REST envelope ({metaInfo: {resCode, message}}), and the Spring Boot
  // default error body ({status: 404, error: "Not Found", message}) for a
  // GSPA route that does not exist.
  _raiseGspaError(statusCode, data) {
    if (statusCode === 401) throw new AuthenticationError('GSPA: token expired or invalid');
    const meta = data && typeof data === 'object' ? dictGet(data, 'metaInfo', {}) : {};
    if (
      (!meta || !Object.keys(meta).length)
      && !data.rc
      && Number.isInteger(data.status)
      && data.error
    ) {
      const springCode = data.status;
      const springMsg = dictGet(data, 'message', '');
      if (springCode === 404) throw new UnsupportedControlError(`GSPA not supported: ${springCode} ${springMsg}`);
      if (springCode === 403) throw new AuthenticationError(`GSPA auth/stamp: ${springCode} ${springMsg}`);
      if (springCode >= 500) throw new ServiceTemporaryUnavailable(`GSPA transient: ${springCode} ${springMsg}`);
      throw new APIError(`GSPA error: rc=${springCode}, msg=${springMsg}`);
    }
    const resCode = (meta && meta.resCode) || data.rc;
    const msg = (meta && meta.message) || dictGet(data, 'msg', '');
    // Business-state message takes precedence over the resCode mapping: the
    // OTA check returns 404-007 "No update info found by vin" — a normal
    // "nothing pending" state, not an unsupported control.
    if (String(msg).toLowerCase().includes('update info')) {
      throw new APIError(`No pending OTA update: ${resCode} ${msg}`.trim());
    }
    if (typeof resCode === 'string') {
      const mapping = GspaApiEU.GSPA_RES_CODE_MAPPING;
      const mapped = mapping[resCode] || (resCode.length > 3 ? mapping[resCode.slice(0, 3)] : undefined);
      if (mapped !== undefined) {
        const [ExcClass, label] = mapped;
        throw new ExcClass(`${label}: ${resCode} ${msg}`);
      }
    }
    if (statusCode >= 500 || (typeof resCode === 'string' && resCode.startsWith('5'))) {
      throw new ServiceTemporaryUnavailable(`GSPA transient: ${resCode} ${msg}`);
    }
    throw new APIError(`GSPA error: rc=${resCode}, msg=${msg}`);
  }

  // ------------------------------------------------------------------
  // GSPA control: PIN-derived control token + control commands
  // ------------------------------------------------------------------

  // Verify the PIN and return [controlToken, expiryEpochSeconds], cached on
  // the Token (controlToken / controlTokenExpiry) like ApiImplType1 does.
  //   POST {CCI_API_URL}/auth/v1/pin   body: {"pin": "<pin>"}
  //   -> {"isMatched": true, "controlTokenInfo": {"controlToken": "...", "expiresTime": <ttl s>}}
  // Fingerprint-gated like the other /auth endpoints; the legacy domain/api
  // route runs unsigned as fallback.
  async _getControlToken(token) {
    const now = Date.now() / 1000;
    if (token.controlToken !== null && token.controlToken !== undefined && token.controlTokenExpiry > now) {
      return [token.controlToken, token.controlTokenExpiry];
    }
    if (!token.pin) throw new UnsupportedControlError('PIN is not configured — remote control requires a PIN');
    const payload = JSON.stringify({ pin: token.pin });
    let headers = this._cciFpHeaders(token.deviceId || '', payload);
    headers['Content-Type'] = 'application/json';
    headers.authorization = `Bearer ${(token.cciAccessToken || '').replace(/^Bearer /, '').trim()}`;
    headers.Authentication = token.nonCcsToken || '';
    if (token.exchangeableToken) {
      headers['exchangeable-token'] = token.exchangeableToken;
      headers['non-ccs-token'] = token.nonCcsToken || '';
    }
    let s = new ApiImplSession({ logger: this.logger });
    let response = await s.request('POST', `${this.CCI_API_URL}/auth/v1/pin`, { headers, body: payload });
    let text = await response.text().catch(() => '');
    if (response.status !== 200 && isGateRejection(response.status, text)) {
      this.logger.error(`Fingerprint gate rejected the signed PIN verification (HTTP ${response.status}); fell back to the legacy route`);
      headers = this._cciTokenHeaders(token, 'application/json');
      s = new ApiImplSession({ logger: this.logger });
      response = await s.postJson(`${this.CCI_DOMAIN_API_URL}v1/auth/pin`, { pin: token.pin }, { headers });
      text = await response.text().catch(() => '');
    }
    let resp;
    try {
      resp = JSON.parse(text);
    } catch {
      throw new APIError('CCI PIN endpoint returned a non-JSON body');
    }
    if (resp.isMatched !== true) {
      // 2xx business error: HTTP 200 with isMatched false. After 5 failed
      // attempts the server locks PIN entry for a window: remainCount drops
      // 4->0 per failure, and while locked even the CORRECT pin returns
      // isMatched false. remainTime is the window length in seconds.
      const failed = resp.remainCountOnFailedInfo || {};
      const remaining = failed.remainCount;
      if (remaining === 0) {
        throw new APIError(`PIN is temporarily locked by the server (lockout window: ${failed.remainTime}s). Wait for the lockout to expire, then the correct PIN will work again.`);
      }
      if (remaining !== undefined && remaining !== null) {
        throw new APIError(`PIN verification failed, ensure PIN is entered correctly. (${remaining} attempts remaining)`);
      }
      throw new APIError('PIN verification failed, ensure PIN is entered correctly.');
    }
    const info = dictGet(resp, 'controlTokenInfo', {}) || {};
    const { controlToken } = info;
    if (!controlToken) throw new InvalidAPIResponseError('CCI PIN response missing controlToken');
    const expiresMs = parseInt(dictGet(info, 'expiresTime', 0), 10);
    if (Number.isNaN(expiresMs)) throw new InvalidAPIResponseError('CCI PIN response missing expiresTime');
    // expiresTime is a relative TTL in seconds (600 = 10 min); fall back
    // through ms/seconds epoch values in case the server switches (values
    // > 1e12 are implausible as a TTL).
    let expireAt;
    if (expiresMs > 1e12) expireAt = Math.floor(expiresMs / 1000); // ms epoch
    else if (expiresMs > 1e9) expireAt = expiresMs; // seconds epoch
    else expireAt = Math.floor(now) + expiresMs; // TTL seconds
    token.controlToken = `Bearer ${controlToken}`;
    token.controlTokenExpiry = expireAt;
    return [token.controlToken, token.controlTokenExpiry];
  }

  // Drop the cached control token so the next command re-verifies the PIN
  // (401-retry path).
  _invalidateControlToken(token) {
    token.controlToken = null;
    token.controlTokenExpiry = 0;
  }

  // Headers for PIN-gated GSPA control commands: the authenticated base,
  // with Authorization carrying the PIN-derived control token (mirrored in
  // AuthorizationCCSP).
  async _getControlHeaders(token, vehicleConfig) {
    const [controlToken] = await this._getControlToken(token);
    const headers = this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport || 0);
    headers.Authorization = controlToken;
    headers.AuthorizationCCSP = controlToken;
    return headers;
  }

  // Dispatch request headers by endpoint auth class (bearer vs PIN).
  async _getControlRequestHeaders(token, vehicleConfig, endpoint) {
    if (this.GSPA_BEARER_ENDPOINTS.has(endpoint)) {
      return this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport || 0);
    }
    return this._getControlHeaders(token, vehicleConfig);
  }

  // Send a control command via a GSPA endpoint:
  // POST {CCSP_API_URL}/gspa/v1/{prefix}/{carId}/{endpoint}. Success is
  // {"data": {...}, "metaInfo": {"retCode": "S", "resCode": "202-000"}},
  // "data" carrying SID (primary polling handle) or svcSID; the legacy
  // {"rt", "rc", "rs"} keys stay as a fallback. Returns "gspa:{SID}", or the
  // bare "gspa:" when accepted with an empty "data" object.
  async _gspaControlCommand(token, vehicleConfig, endpoint, body, pathPrefix = null) {
    const data = await this._gspaPostForData(token, vehicleConfig, endpoint, body, pathPrefix);
    const dataPayload = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : {};
    const { rs } = data;
    const rsPayload = rs && typeof rs === 'object' && !Array.isArray(rs) ? rs : {};
    const sid = dataPayload.SID
      || dataPayload.svcSID
      || data.SID
      || rsPayload.SID
      || data.svcSID
      || rsPayload.svcSID
      || '';
    if (!sid) {
      // Some commands (e.g. rearseat-alarm) are accepted (HTTP 202, retCode
      // "S") with an EMPTY "data" object — the command was executed, so
      // don't report a failure.
      this.logger.log(`GSPA control accepted without a polling SID (rc=${data.rc || 'S'}); status polling has no handle`);
      return 'gspa:';
    }
    return `gspa:${sid}`;
  }

  // POST a GSPA command and return the parsed response body. Shared by
  // _gspaControlCommand and the OTA commands: body normalization ("command",
  // not "action"; no "deviceId"), bearer/PIN header dispatch, and one retry
  // after a 401 on a PIN-gated endpoint (with the control token dropped).
  // Pre-CCS2 vehicles raise UnsupportedControlError, and commands not
  // live-verified on this brand raise "not implemented" before any request.
  async _gspaPostForData(token, vehicleConfig, endpoint, body, pathPrefix = null) {
    if (!(this.GSPA_REMOTE_CONTROL_VERIFIED || this.GSPA_VERIFIED_ENDPOINTS.has(endpoint))) {
      throw new Error(`${this.constructor.name} GSPA remote control awaits live verification`);
    }
    if (!vehicleConfig.ccuCCS2ProtocolSupport) {
      throw new UnsupportedControlError('Pre-CCS2 EU vehicles are not supported by the CCI region — use region 1 (Europe) for remote control');
    }
    const gspaEndpoint = dictGet(this.GSPA_ENDPOINT_MAP, endpoint, endpoint);
    const prefix = pathPrefix || dictGet(this.GSPA_PATH_PREFIX_MAP, endpoint, 'remote/vehicles');
    // Normalize legacy bodies: GSPA uses "command"; no deviceId.
    if ('action' in body && !('command' in body)) {
      const actionValue = body.action;
      body = Object.fromEntries(Object.entries(body).filter(([k]) => !['action', 'deviceId'].includes(k)));
      body.command = actionValue;
    }
    body = Object.fromEntries(Object.entries(body).filter(([k]) => !['action', 'deviceId'].includes(k)));

    const url = `${this.CCSP_API_URL}/gspa/v1/${prefix}/${vehicleConfig.id}/${gspaEndpoint}`;
    this._validateCcsToken(token);
    const pinGated = !this.GSPA_BEARER_ENDPOINTS.has(endpoint);
    let response;
    for (const attempt of [1, 2]) {
      const headers = await this._getControlRequestHeaders(token, vehicleConfig, endpoint);
      response = await this._requests().postJson(url, body, { headers });
      if (response.status === 401 && pinGated && attempt === 1) {
        this._invalidateControlToken(token);
        continue;
      }
      break;
    }

    const text = await response.text();
    if (response.status >= 400) {
      let errData;
      try {
        errData = JSON.parse(text);
      } catch {
        errData = {};
      }
      this._raiseGspaError(response.status, errData);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new InvalidAPIResponseError(`GSPA control returned non-JSON body: ${JSON.stringify(text.slice(0, 200))}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidAPIResponseError('GSPA control returned non-object JSON');
    }
    // Success: {"data": {...}, "metaInfo": {"retCode": "S", ...}}; a 2xx
    // business failure carries retCode "F". Legacy {"rt", "rc", "rs"} keys
    // stay as a fallback.
    const meta = data.metaInfo;
    const metaPayload = meta && typeof meta === 'object' ? meta : {};
    const rc = data.rc || metaPayload.retCode;
    if (rc && !['0000', 'S'].includes(rc)) this._raiseGspaError(response.status, data);
    return data;
  }

  // Poll a GSPA action's status:
  // GET /gspa/v1/status/vehicles/{carId}/update-status?path=gspa/v1/remote/vehicles
  // -> {"metaInfo": {"retCode": "S"}, "data": {"pollingState": "WAIT" | "SUCCESS" | "FAILURE" | "TIMEOUT"}}.
  // Any transport/parse error or non-success retCode reports PENDING.
  async _gspaCheckActionStatus(token, vehicleConfig, sid) {
    const url = `${this.CCSP_API_URL}/gspa/v1/status/vehicles/${vehicleConfig.id}/update-status?path=${this.GSPA_REMOTE_VEHICLES_PATH}`;
    this._validateCcsToken(token);
    const headers = this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport || 0);
    try {
      const response = await this._requests().get(url, { headers });
      // A successful poll returns HTTP 202 ("202-000 Accepted"), not 200.
      if (!(response.status >= 200 && response.status < 300)) return ORDER_STATUS.PENDING;
      const data = await response.json();
      const meta = dictGet(data, 'metaInfo', {});
      if (meta.retCode !== 'S') return ORDER_STATUS.PENDING;
      const payload = dictGet(data, 'data', {});
      const pollingState = dictGet(payload, 'pollingState', '');
      if (pollingState === 'SUCCESS') return ORDER_STATUS.SUCCESS;
      if (pollingState === 'FAILURE') return ORDER_STATUS.FAILED;
      if (pollingState === 'TIMEOUT') return ORDER_STATUS.TIMEOUT;
    } catch {
      this.logger.log(`GSPA action status poll failed for SID ${sid}`);
    }
    return ORDER_STATUS.PENDING;
  }

  // GET from a GSPA endpoint (X-Stamp gated): CCSP host + /gspa/v1/ prefix.
  // Envelope: {"data": {...}, "metaInfo": {"retCode": "S", "resCode": "200-000"}}
  // Returns the data (domain payload), or null on business errors.
  async _gspaGet(token, vehicleConfig, endpoint, params = null) {
    this._validateCcsToken(token);
    const carId = vehicleConfig.id;
    let url = `${this.CCSP_API_URL}/gspa/v1/${endpoint.replace('{carId}', carId)}`;
    if (params) url += `?${new URLSearchParams(params).toString()}`;
    const headers = this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport || 0);

    const response = await this._requests().get(url, { headers });
    if (response.status === 401) throw new AuthenticationError('GSPA: Token expired or invalid');
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new APIError(`GSPA error: HTTP ${response.status} non-JSON body: ${JSON.stringify(text.slice(0, 200))}`);
    }
    const meta = dictGet(data, 'metaInfo', {});
    const resCode = dictGet(meta, 'resCode', '');

    if (response.status === 403) throw new APIError(`GSPA auth error: ${resCode} ${dictGet(meta, 'message', '')}`);
    if (response.status >= 400) throw new APIError(`GSPA error: HTTP ${response.status} ${resCode}`);

    if (meta.retCode !== 'S') {
      this.logger.log(`GSPA GET ${endpoint}: ${resCode} ${dictGet(meta, 'message', '')}`);
      return null;
    }

    return dictGet(data, 'data', null);
  }

  // ------------------------------------------------------------------
  // GSPA prewakeup (brand-neutral; inherited by both EU CCI brands)
  // ------------------------------------------------------------------

  // Send a prewakeup command to bring the vehicle online. The app always
  // sends the body {"action": "prewakeup"}; confirmed upstream on a Kia EV6
  // (HTTP 202). Returns the "rs" payload, or null on a non-auth failure.
  async prewakeup(token, vehicleConfig) {
    const url = `${this.CCSP_API_URL}/gspa/v1/remote/vehicles/${vehicleConfig.id}/prewakeup`;
    this._validateCcsToken(token);
    const headers = this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport || 0);
    try {
      const response = await this._requests().postJson(url, { action: 'prewakeup' }, { headers, timeout: 60 * 1000 });
      if (response.status === 401) throw new AuthenticationError('GSPA: Token expired or invalid');
      const text = await response.text();
      if (response.status >= 400) throw new APIError(`GSPA control error: HTTP ${response.status} - ${text.slice(0, 200)}`);
      const data = JSON.parse(text);
      const { rc } = data;
      if (rc && rc !== '0000') throw new APIError(`GSPA error: rc=${rc}, msg=${dictGet(data, 'msg', '')}`);
      return dictGet(data, 'rs', data);
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      this.logger.log('GSPA prewakeup failed');
      return null;
    }
  }

  // ------------------------------------------------------------------
  // GSPA stored-status
  // ------------------------------------------------------------------

  // Cached vehicle status from the GSPA stored-status endpoint. Returns the
  // data object (CCS2 nested format under state.Vehicle), or null on failure.
  async getStoredStatus(token, vehicleConfig) {
    this._validateCcsToken(token);
    try {
      return await this._gspaGet(token, vehicleConfig, 'status/vehicles/{carId}/stored-status');
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      this.logger.log('GSPA stored-status failed');
      return null;
    }
  }

  // Shared part of both brands' update_vehicle_with_cached_state. Returns the
  // bare CCS2 Vehicle object instead of parsing it (see ../NAMING.md), the
  // same shape KiaUvoApiEU.js returns for a CCS2 car.
  async _cachedCcs2State(token, vehicleConfig) {
    if (!(token.accessToken || token.exchangeableToken)) {
      throw new APIError('No CCS token — cannot fetch GSPA stored-status');
    }
    const data = await this.getStoredStatus(token, vehicleConfig);
    if (!data) throw new APIError('GSPA stored-status returned no data');
    let state = dictGet(data, 'state', {});
    if (state && typeof state === 'object' && 'Vehicle' in state) state = state.Vehicle;
    return state;
  }

  // Upstream ApiImpl._get_drv_seat_loc: "R" for mile-based (RHD) markets,
  // otherwise "L". Same as ApiImplType1.js#_getDrvSeatLoc.
  _getDrvSeatLoc(vehicleConfig) {
    return vehicleConfig.odometerUnit === 'mi' ? 'R' : 'L';
  }

  // ------------------------------------------------------------------
  // Remote control (GSPA) — dispatcher
  // ------------------------------------------------------------------

  // Poll the status of a previously issued control action. The CCI region
  // only issues "gspa:" action ids. Brands with GSPA_REMOTE_CONTROL_VERIFIED
  // false raise "not implemented".
  // eslint-disable-next-line no-unused-vars
  async checkActionStatus(token, vehicleConfig, actionId, synchronous = false, timeout = 0) {
    if (!this.GSPA_REMOTE_CONTROL_VERIFIED) {
      throw new Error(`${this.constructor.name} GSPA remote control awaits live verification`);
    }
    if (actionId.startsWith('gspa:')) {
      return this._gspaCheckActionStatus(token, vehicleConfig, actionId.slice('gspa:'.length));
    }
    throw new UnsupportedControlError(`Cannot poll action ${JSON.stringify(actionId)}: the CCI region only issues 'gspa:' action ids`);
  }

  // ------------------------------------------------------------------
  // Remote control (GSPA) — simple commands
  // ------------------------------------------------------------------

  // Lock/unlock via the granular per-action endpoints: POST .../door-lock
  // {"command": "set"} and .../door-unlock (the "lock"/"CLOSE" body forms are
  // rejected with 400-002).
  lockAction(token, vehicleConfig, action) {
    const endpoint = action === VEHICLE_LOCK_ACTION.LOCK ? 'door-lock' : 'door-unlock';
    return this._gspaControlCommand(token, vehicleConfig, endpoint, { command: 'set' });
  }

  doorPowerOff(token, vehicleConfig) {
    return this._gspaControlCommand(token, vehicleConfig, 'door-power-off', { command: 'set' });
  }

  startCharge(token, vehicleConfig) {
    return this._gspaControlCommand(token, vehicleConfig, 'charge', { command: 'start' });
  }

  stopCharge(token, vehicleConfig) {
    return this._gspaControlCommand(token, vehicleConfig, 'charge', { command: 'stop' });
  }

  chargePortAction(token, vehicleConfig, action) {
    const command = action === CHARGE_PORT_ACTION.OPEN ? 'open' : 'close';
    return this._gspaControlCommand(token, vehicleConfig, 'portdoor', { command });
  }

  openFrunk(token, vehicleConfig) {
    return this._gspaControlCommand(token, vehicleConfig, 'frunk', { command: 'open' });
  }

  startHazardLights(token, vehicleConfig) {
    return this._gspaControlCommand(token, vehicleConfig, 'light', { command: 'on' });
  }

  startHazardLightsAndHorn(token, vehicleConfig) {
    return this._gspaControlCommand(token, vehicleConfig, 'hornlight', { command: 'on' });
  }

  turnOffLamp(token, vehicleConfig, mode = 'all-off') {
    return this._gspaControlCommand(token, vehicleConfig, 'lamp', { command: mode });
  }

  startBatteryConditioning(token, vehicleConfig) {
    return this._gspaControlCommand(token, vehicleConfig, 'battery-conditioning', { command: 'start' });
  }

  stopBatteryConditioning(token, vehicleConfig) {
    return this._gspaControlCommand(token, vehicleConfig, 'battery-conditioning', { command: 'stop' });
  }

  stopRearSeatAlarm(token, vehicleConfig) {
    return this._gspaControlCommand(token, vehicleConfig, 'rearseat-alarm', { command: 'stop' }, 'safety/vehicles');
  }

  // Activate/deactivate valet mode: POST /gspa/v1/valet/vehicles/{carId}/control.
  valetModeAction(token, vehicleConfig, action) {
    const command = action === VALET_MODE_ACTION.ACTIVATE ? 'activate' : 'deactivate';
    return this._gspaControlCommand(token, vehicleConfig, 'control', { command }, 'valet/vehicles');
  }

  // ------------------------------------------------------------------
  // Remote control (GSPA) — climate / engine / pet care
  // ------------------------------------------------------------------

  // Map the climate options' seat fields to the seatClimateInfo shape.
  static _buildSeatClimateInfo(options) {
    const info = {};
    if (isSet(options.frontLeftSeat)) info.drvSeatClimateState = options.frontLeftSeat;
    if (isSet(options.frontRightSeat)) info.psgSeatClimateState = options.frontRightSeat;
    if (isSet(options.rearLeftSeat)) info.rlSeatClimateState = options.rearLeftSeat;
    if (isSet(options.rearRightSeat)) info.rrSeatClimateState = options.rearRightSeat;
    return Object.keys(info).length ? info : null;
  }

  startClimate(token, vehicleConfig, options) {
    const body = { command: 'start' };
    if (isSet(options.setTemp)) body.hvacTemp = String(options.setTemp);
    if (isSet(options.defrost)) body.windshieldFrontDefogState = options.defrost;
    if (isSet(options.heating)) body.heating1 = options.heating;
    // tempUnit is a string on the wire ("C"/"F"); the 0/1 int form is
    // rejected with 400-002.
    if (isSet(options.tempUnit)) body.tempUnit = options.tempUnit === 1 ? 'F' : 'C';
    if (isSet(options.hvacTempType)) body.hvacTempType = options.hvacTempType;
    if (isSet(options.driverSeatLocation)) body.drvSeatLoc = options.driverSeatLocation;
    if (isSet(options.duration)) body.ignitionDuration = options.duration;
    if (isSet(options.steeringWheel)) body.strgWhlHeating = options.steeringWheel;
    if (isSet(options.sideRearMirrorHeating)) body.sideRearMirrorHeating = options.sideRearMirrorHeating;
    const seatInfo = GspaApiEU._buildSeatClimateInfo(options);
    if (seatInfo) body.seatClimateInfo = seatInfo;
    if (isSet(options.setTemp)) {
      // Without tempUnit/hvacTempType the backend ignores hvacTemp and
      // applies the car's stored set point instead.
      if (!('tempUnit' in body)) body.tempUnit = 'C';
      if (!('hvacTempType' in body)) body.hvacTempType = 1;
    }
    return this._gspaControlCommand(token, vehicleConfig, 'temperature', body);
  }

  stopClimate(token, vehicleConfig) {
    return this._gspaControlCommand(token, vehicleConfig, 'temperature', { command: 'stop' });
  }

  // Remote start via the engine endpoint: the start_climate fields plus
  // hvacCtrl (options.climate).
  startEngine(token, vehicleConfig, options = null) {
    const body = { command: 'start' };
    if (options) {
      if (isSet(options.setTemp)) body.hvacTemp = String(options.setTemp);
      if (isSet(options.defrost)) body.windshieldFrontDefogState = options.defrost;
      if (isSet(options.climate)) body.hvacCtrl = options.climate ? 1 : 0;
      if (isSet(options.heating)) body.heating1 = options.heating;
      if (isSet(options.tempUnit)) body.tempUnit = options.tempUnit === 1 ? 'F' : 'C';
      if (isSet(options.hvacTempType)) body.hvacTempType = options.hvacTempType;
      if (isSet(options.driverSeatLocation)) body.drvSeatLoc = options.driverSeatLocation;
      if (isSet(options.duration)) body.ignitionDuration = options.duration;
      if (isSet(options.steeringWheel)) body.strgWhlHeating = options.steeringWheel;
      if (isSet(options.sideRearMirrorHeating)) body.sideRearMirrorHeating = options.sideRearMirrorHeating;
      const seatInfo = GspaApiEU._buildSeatClimateInfo(options);
      if (seatInfo) body.seatClimateInfo = seatInfo;
      if (isSet(options.setTemp)) {
        if (!('tempUnit' in body)) body.tempUnit = 'C';
        if (!('hvacTempType' in body)) body.hvacTempType = 1;
      }
    }
    return this._gspaControlCommand(token, vehicleConfig, 'engine', body);
  }

  stopEngine(token, vehicleConfig) {
    return this._gspaControlCommand(token, vehicleConfig, 'engine', { command: 'stop' });
  }

  // tempUnit values ported verbatim from upstream's protocol tables —
  // awaiting live validation there.
  startPetCare(token, vehicleConfig, options = null) {
    const temp = options && options.setTemp ? options.setTemp : 21;
    const body = { hvacTemp: String(temp), tempUnit: 'F' };
    return this._gspaControlCommand(token, vehicleConfig, 'pet-care', body);
  }

  stopPetCare(token, vehicleConfig) {
    const body = { hvacTemp: '21', tempUnit: 'C' };
    return this._gspaControlCommand(token, vehicleConfig, 'pet-care', body);
  }

  // ------------------------------------------------------------------
  // Remote control (GSPA) — windows
  // ------------------------------------------------------------------

  // Set window state via the scope-based window-curtain endpoint. GSPA
  // supports scope commands only (all windows or front windows); a mixed
  // per-window request raises UnsupportedControlError. Window values are
  // WINDOW_STATE codes (0 = closed, 1 = open, 2 = vent).
  setWindowsState(token, vehicleConfig, options) {
    if (!this.supportsWindowControl) throw new APIError('Window control not supported');
    const drvSeatLoc = options.driverSeatLocation || this._getDrvSeatLoc(vehicleConfig);
    const front = [options.frontLeft, options.frontRight];
    const rl = options.backLeft;
    const rr = options.backRight;
    const seats = [options.frontLeft, options.frontRight, rl, rr];
    if (
      seats.every((s) => !isSet(s))
      && !isSet(options.rearLeftCurtain)
      && !isSet(options.rearRightCurtain)
    ) {
      throw new UnsupportedControlError('No window state requested');
    }
    let command = null;
    if (seats.every((s) => s === WINDOW_STATE.CLOSED)) {
      command = 'window-close';
    } else if (seats.every((s) => s === WINDOW_STATE.OPEN)) {
      command = 'window-open';
    } else if (seats.every((s) => s === WINDOW_STATE.VENTILATION)) {
      command = 'vent';
    } else if (!isSet(rl) && !isSet(rr)) {
      if (front.every((s) => s === WINDOW_STATE.CLOSED)) command = 'front-close';
      else if (front.every((s) => s === WINDOW_STATE.OPEN)) command = 'front-open';
      else if (front.every((s) => s === WINDOW_STATE.VENTILATION)) command = 'front-vent';
    }
    if (command === null) {
      throw new UnsupportedControlError('Mixed per-window state is not supported via GSPA — use setWindowCurtain for per-seat windows/curtains');
    }
    const frontVal = isSet(options.frontLeft) ? options.frontLeft : null;
    const rearVal = ['window-close', 'window-open', 'vent'].includes(command) ? frontVal : null;
    const body = {
      command,
      drvSeatWindow: frontVal,
      psgSeatWindow: frontVal,
      rlSeatWindow: rearVal,
      rrSeatWindow: rearVal,
      rlSeatWindowCurtain: null,
      rrSeatWindowCurtain: null,
      drvSeatLoc,
    };
    return this._gspaControlCommand(token, vehicleConfig, 'windowcurtain', body);
  }

  // Set per-seat windows/curtains via the window-curtain endpoint. Takes
  // position-based options (frontLeft is the physical front-left window) and
  // maps them onto the seat-based body keys using drvSeatLoc: on RHD the
  // driver sits on the right, so frontLeft drives psgSeatWindow.
  setWindowCurtain(token, vehicleConfig, options) {
    const body = { command: 'open' };
    const drvSeatLoc = options.driverSeatLocation || this._getDrvSeatLoc(vehicleConfig);
    const [drvKey, psgKey] = drvSeatLoc === 'R'
      ? ['psgSeatWindow', 'drvSeatWindow']
      : ['drvSeatWindow', 'psgSeatWindow'];
    if (isSet(options.frontLeft)) body[drvKey] = options.frontLeft;
    if (isSet(options.frontRight)) body[psgKey] = options.frontRight;
    if (isSet(options.backLeft)) body.rlSeatWindow = options.backLeft;
    if (isSet(options.backRight)) body.rrSeatWindow = options.backRight;
    if (isSet(options.rearLeftCurtain)) body.rlSeatWindowCurtain = options.rearLeftCurtain;
    if (isSet(options.rearRightCurtain)) body.rrSeatWindowCurtain = options.rearRightCurtain;
    body.drvSeatLoc = drvSeatLoc;
    return this._gspaControlCommand(token, vehicleConfig, 'window-curtain', body);
  }

  // ------------------------------------------------------------------
  // Remote control (GSPA) — charge settings and reservations (bearer)
  // ------------------------------------------------------------------

  setChargeLimits(token, vehicleConfig, ac, dc) {
    const body = {
      targetSOClist: [
        { plugType: 0, targetSOClevel: Math.trunc(dc) },
        { plugType: 1, targetSOClevel: Math.trunc(ac) },
      ],
      command: 'set',
    };
    return this._gspaControlCommand(token, vehicleConfig, 'charge-target', body);
  }

  setChargingCurrent(token, vehicleConfig, level) {
    const body = { chargingCurrent: level, command: 'set' };
    return this._gspaControlCommand(token, vehicleConfig, 'charging-current', body);
  }

  setVehicleToLoadDischargeLimit(token, vehicleConfig, limit) {
    const body = { dischargingLimit: Math.trunc(limit), command: 'set' };
    return this._gspaControlCommand(token, vehicleConfig, 'discharge-limit', body);
  }

  setChargeAlarm(token, vehicleConfig, enabled) {
    const body = enabled
      ? {
        alarmOff: 0, alarmBefore10: 1, alarmBefore20: 1, alarmBefore30: 1, command: 'set',
      }
      : {
        alarmOff: 1, alarmBefore10: 0, alarmBefore20: 0, alarmBefore30: 0, command: 'set',
      };
    return this._gspaControlCommand(token, vehicleConfig, 'charge-alarm', body);
  }

  // Schedule options here use the same camelCase shape as
  // ApiImplType1.js#scheduleChargingAndClimate: departures
  // {enabled, days, time: 'HH:MM'}, offPeakStartTime/offPeakEndTime 'HH:MM'.
  // Upstream mutates the options to fill its defaults; this fills local
  // copies instead.

  // Schedule standalone charging reservation (flat DTO shape).
  scheduleReservationCharge(token, vehicleConfig, options = {}) {
    const makeTime = (t) => formatScheduleTime(t);
    const body = {
      reservFlag: options.chargingEnabled ? 1 : 0,
      offpeakPowerFlag: options.offPeakChargeOnlyEnabled ? 2 : 1,
      reservStartTime: makeTime(options.offPeakStartTime || '00:00'),
      reservEndTime: makeTime(options.offPeakEndTime || options.offPeakStartTime || '00:00'),
      command: 'set',
    };
    return this._gspaControlCommand(token, vehicleConfig, 'reservation-charge', body);
  }

  // Schedule standalone HVAC reservation (reservedHVACInfo1/2 shape).
  scheduleReservationHvac(token, vehicleConfig, options = {}) {
    const firstDeparture = options.firstDeparture || {};
    const secondDeparture = options.secondDeparture || {};
    const temperatureUnit = isSet(options.temperatureUnit) ? options.temperatureUnit : 0;
    const defrost = isSet(options.defrost) ? options.defrost : false;

    let temperature = isSet(options.temperature) ? options.temperature : 21.0;
    if (temperatureUnit === 0) {
      temperature = pyRound(temperature * 2.0) / 2.0;
      temperature = Math.max(17.0, Math.min(27.0, temperature));
    }

    const makeReservInfo = (dep) => ({
      scheduleEnable: isSet(dep.enabled) ? dep.enabled : false,
      day: (dep.days && dep.days.length) ? dep.days : [0],
      time: formatScheduleTime(dep.time || '00:00').time,
      windshieldFrontDefogState: defrost || false,
      ignitionDuration: 10,
      hvacCtrl: options.climateEnabled ? 1 : 0,
      hvacTempType: 1,
      hvacTemp: pyFixed1(temperature),
      tempUnit: temperatureUnit,
      drvSeatLoc: 'L',
    });

    const makeHvacSet = () => ({
      airCtrl: options.climateEnabled ? 1 : 0,
      defrost: defrost || false,
      airTemp: { value: pyFixed1(temperature), hvacTempType: 1, unit: temperatureUnit },
      heating1: 0,
      airPurifierControl: 0,
    });

    const body = {
      reservedHVACInfo1: {
        reservHVACflag: firstDeparture.enabled ? 1 : 0,
        reservInfo: makeReservInfo(firstDeparture),
        reservHVACSet: makeHvacSet(),
      },
      reservedHVACInfo2: {
        reservHVACflag: secondDeparture.enabled ? 1 : 0,
        reservInfo: makeReservInfo(secondDeparture),
        reservHVACSet: makeHvacSet(),
      },
      command: 'set',
    };
    return this._gspaControlCommand(token, vehicleConfig, 'reservation-hvac', body);
  }

  // Schedule ICE engine remote-start reservation (reservInfo/2 shape).
  scheduleReservationEngine(token, vehicleConfig, options = {}) {
    const firstDeparture = options.firstDeparture || {};
    const secondDeparture = options.secondDeparture || {};
    const temperatureUnit = isSet(options.temperatureUnit) ? options.temperatureUnit : 0;
    const defrost = isSet(options.defrost) ? options.defrost : false;

    let temperature = isSet(options.temperature) ? options.temperature : 21.0;
    if (temperatureUnit === 0) {
      temperature = pyRound(temperature * 2.0) / 2.0;
      temperature = Math.max(17.0, Math.min(27.0, temperature));
    }

    const makeEngineReservInfo = (dep) => ({
      scheduleEnable: isSet(dep.enabled) ? dep.enabled : false,
      day: (dep.days && dep.days.length) ? dep.days : [0],
      time: formatScheduleTime(dep.time || '00:00').time,
      windshieldFrontDefogState: defrost || false,
      ignitionDuration: 10,
      hvacCtrl: options.climateEnabled ? 1 : 0,
      hvacTempType: 1,
      hvacTemp: pyFixed1(temperature),
      tempUnit: temperatureUnit,
      drvSeatLoc: 'L',
    });

    const body = {
      reservInfo: makeEngineReservInfo(firstDeparture),
      reservInfo2: makeEngineReservInfo(secondDeparture),
    };
    return this._gspaControlCommand(token, vehicleConfig, 'reservation-engine', body);
  }

  // Schedule the NA-variant charging reservation: one weekly charge window
  // (active days + start + end time), no climate or target SoC; the app
  // hardcodes reservChargeSet to false. `days` uses Sun=0..Sat=6; start/end
  // are 'HH:MM' wall clock in dataTimezone, sent as UTC "HH:MM:00Z", day
  // indices shifting across the UTC midnight boundary. Bearer-authenticated.
  scheduleReservationChargeNa(token, vehicleConfig, days, start, end) {
    if (!days || !days.length) throw new RangeError('scheduleReservationChargeNa requires at least one day');

    const toUtc = (t, day = null) => {
      const [hours, minutes] = t.split(':').map(Number);
      const ref = zonedParts(new Date(), this.dataTimezone);
      let dayOffset = 0;
      if (day !== null) dayOffset = (((day - ref.weekday) % 7) + 7) % 7;
      const wallMs = Date.UTC(ref.year, ref.month - 1, ref.day + dayOffset, hours, minutes);
      const utc = new Date(wallMs - zoneOffsetMs(new Date(wallMs), this.dataTimezone));
      const hh = String(utc.getUTCHours()).padStart(2, '0');
      const mm = String(utc.getUTCMinutes()).padStart(2, '0');
      return [utc.getUTCDay(), `${hh}:${mm}:00Z`];
    };

    const wireDays = [];
    let startWire = '';
    [...new Set(days)].sort((a, b) => a - b).forEach((day) => {
      let wireDay;
      [wireDay, startWire] = toUtc(start, day);
      wireDays.push(wireDay);
    });
    const endWire = toUtc(end)[1];

    const body = {
      reservChargeInfo: {
        reservInfo: { day: wireDays, time: startWire },
        reservEndTime: endWire,
        reservChargeSet: false,
      },
    };
    return this._gspaControlCommand(token, vehicleConfig, 'reservation-charge-na', body);
  }

  scheduleChargingAndClimate(token, vehicleConfig, options = {}) {
    const body = this._buildReservationBody(options);
    return this._gspaControlCommand(token, vehicleConfig, 'reservation-charge-hvac', body);
  }

  // Build the reservation-charge-hvac body from options.
  // eslint-disable-next-line class-methods-use-this
  _buildReservationBody(options) {
    const setDefaultDepartureOptions = (departureOptions) => ({
      enabled: isSet(departureOptions.enabled) ? departureOptions.enabled : false,
      days: isSet(departureOptions.days) ? departureOptions.days : [0],
      time: isSet(departureOptions.time) ? departureOptions.time : '00:00',
    });

    const firstDeparture = options.firstDeparture || {};
    const secondDeparture = options.secondDeparture || {};
    const departures = [setDefaultDepartureOptions(firstDeparture), setDefaultDepartureOptions(secondDeparture)];

    const offPeakStartTime = isSet(options.offPeakStartTime) ? options.offPeakStartTime : '00:00';
    const offPeakEndTime = isSet(options.offPeakEndTime) ? options.offPeakEndTime : offPeakStartTime;
    const offPeakChargeOnlyEnabled = isSet(options.offPeakChargeOnlyEnabled) ? options.offPeakChargeOnlyEnabled : false;
    const temperatureUnit = isSet(options.temperatureUnit) ? options.temperatureUnit : 0;
    const defrost = isSet(options.defrost) ? options.defrost : false;

    let temperature = isSet(options.temperature) ? options.temperature : 21.0;
    if (temperatureUnit === 0) {
      temperature = pyRound(temperature * 2.0) / 2.0;
      if (temperature > 27.0) temperature = 27.0;
      else if (temperature < 17.0) temperature = 17.0;
    }

    const reservChargeInfo = {};
    [0, 1].forEach((i) => {
      reservChargeInfo[`reservChargeInfo${i + 1}`] = {
        reservChargeSet: departures[i].enabled,
        reservInfo: {
          day: departures[i].days,
          time: formatScheduleTime(departures[i].time),
        },
        reservFatcSet: {
          airCtrl: options.climateEnabled ? 1 : 0,
          airTemp: { value: pyFixed1(temperature), hvacTempType: 1, unit: temperatureUnit },
          heating1: 0,
          defrost,
        },
      };
    });

    const end = formatScheduleTime(offPeakEndTime);
    const startT = formatScheduleTime(offPeakStartTime);
    return {
      reservChargeInfo,
      offPeakPowerInfo: {
        offPeakPowerTime1: {
          endtime: { timeSection: end.timeSection, time: end.time },
          starttime: { timeSection: startT.timeSection, time: startT.time },
        },
        offPeakPowerFlag: offPeakChargeOnlyEnabled ? 2 : 1,
      },
      reservFlag: options.chargingEnabled ? 1 : 0,
      command: 'set',
    };
  }

  // ------------------------------------------------------------------
  // OTA / software version (GSPA)
  // ------------------------------------------------------------------

  // Schedule or cancel an OTA update reservation:
  // POST /gspa/v1/mru/vehicles/{carId}/ota-updates-reservation, `settings`
  // passed through as the body. Returns the parsed body (no polling SID).
  setOtaReservation(token, vehicleConfig, settings) {
    return this._gspaPostForData(token, vehicleConfig, 'ota-updates-reservation', settings, 'mru/vehicles');
  }

  // Start or cancel a CCU OTA update: POST /gspa/v1/mru/vehicles/{carId}/ota-updates
  // {"updateStart": 1|2} (1 = start, 2 = cancel). Returns the parsed body.
  setOtaUpdate(token, vehicleConfig, start) {
    return this._gspaPostForData(token, vehicleConfig, 'ota-updates', { updateStart: start ? 1 : 2 }, 'mru/vehicles');
  }

  // GET /gspa/v1/mru/vehicles/{carId}/ota-updates. Returns the data, or null.
  async getOtaUpdates(token, vehicleConfig) {
    this._validateCcsToken(token);
    try {
      return await this._gspaGet(token, vehicleConfig, 'mru/vehicles/{carId}/ota-updates');
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      this.logger.log('GSPA ota-updates GET failed');
      return null;
    }
  }

  // GET /gspa/v1/device-info/vehicles/{carId}/software-version. Returns the
  // data, or null.
  async getSoftwareVersion(token, vehicleConfig) {
    this._validateCcsToken(token);
    try {
      return await this._gspaGet(token, vehicleConfig, 'device-info/vehicles/{carId}/software-version');
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      this.logger.log('GSPA software-version GET failed');
      return null;
    }
  }
}

// resCode -> [exception class, message label], keyed by exact code
// ("400-004") or 3-char prefix ("403" matches "403-001").
GspaApiEU.GSPA_RES_CODE_MAPPING = {
  '400-004': [DuplicateRequestError, 'GSPA duplicate'],
  4004: [DuplicateRequestError, 'GSPA duplicate'],
  403: [AuthenticationError, 'GSPA auth/stamp'],
  404: [UnsupportedControlError, 'GSPA not supported'],
};

Object.assign(GspaApiEU.prototype, {
  dataTimezone: 'UTC',
  supportsValetMode: true,

  supportsWindowControl: false,
  supportsSvm: false,

  // Remote control ships per brand only after live verification of the GSPA
  // command layer on that brand. Subclasses flip this to true.
  GSPA_REMOTE_CONTROL_VERIFIED: false,

  // Endpoints individually live-verified on this brand while the rest of
  // GSPA remote control stays gated (GSPA_REMOTE_CONTROL_VERIFIED false).
  GSPA_VERIFIED_ENDPOINTS: new Set(),

  // CCSP endpoint names that differ from their GSPA endpoint names.
  GSPA_ENDPOINT_MAP: {
    hornlight: 'horn-light',
    windowcurtain: 'window-curtain',
  },

  // Endpoints NOT under /gspa/v1/remote/vehicles/{carId}/ (valet control
  // passes pathPrefix 'valet/vehicles' explicitly).
  GSPA_PATH_PREFIX_MAP: {
    'rearseat-alarm': 'safety/vehicles',
  },

  // Endpoints authenticated with the standard GSPA headers (bearer) instead
  // of the PIN-derived control token. Everything else is PIN-gated.
  GSPA_BEARER_ENDPOINTS: new Set([
    'charge-target',
    'charging-current',
    'discharge-limit',
    'charge-alarm',
    'reservation-charge',
    'reservation-charge-na',
    'reservation-hvac',
    'reservation-charge-hvac',
    'reservation-engine',
    // OTA commands: sent with the standard authenticated headers — no
    // PIN-derived control token.
    'ota-updates',
    'ota-updates-reservation',
  ]),

  // Path used for action status polling (?path=...).
  GSPA_REMOTE_VEHICLES_PATH: 'gspa/v1/remote/vehicles',

  // Brand placeholders — every subclass MUST override these.
  ONEAPP_CLIENT_ID: '',
  ONEAPP_REDIRECT_URI: '',
  CCI_API_URL: '',
  CCI_PACKAGE_ID: '',
  GSPA_BASE_URL: '',
  LOGIN_FORM_HOST: '',
  CIPHER_BRAND: '',
  REQUEST_ID_HEADER: '',
  DEVICE_ID_HEADER: '',
  CCSP_SERVICE_ID: '6d477c38-3ca4-4cf3-9557-2a1929a94654',

  // Library region id (9 = Europe CCI upstream) is a different namespace from
  // the stamp-region code the cipher expects. EU CCI stamps use the EU stamp
  // region (1).
  STAMP_REGION: 1,
});

module.exports = GspaApiEU;
