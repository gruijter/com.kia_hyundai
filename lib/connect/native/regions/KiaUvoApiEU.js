'use strict';

// Port of KiaUvoApiEU.py. Works for both Kia and Hyundai EU (like upstream,
// via the `brand` argument) — Genesis was not carried over because this
// Homey app doesn't publish a Genesis brand; port the Genesis branch from
// upstream here if that's ever needed.
//
// Main deviation from upstream: methods that mutate a Vehicle dataclass in
// Python (_update_vehicle_properties(_ccs2), ~1000 lines) were NOT carried
// over here. Instead, updateVehicleWithCachedState and
// forceRefreshVehicleState return the raw cloud JSON, which
// device.js#mapStatus() can already read directly (the same paths the
// Python parsing uses). See ../../NAMING.md.

const crypto = require('crypto');
const { promisify } = require('util');
const { ApiImplSession, USER_AGENT_OK_HTTP } = require('../http');
const { ApiImplType1, checkResponseForErrors, retryOnDeviceIdError } = require('../ApiImplType1');
const Token = require('../Token');
const { BRAND_KIA, BRAND_HYUNDAI, CHARGE_PORT_ACTION } = require('../const');
const { xorStamp, getChildValue } = require('../utils');
const { AuthenticationError, ConsentRequiredError } = require('../exceptions');
const { prefixLogger } = require('../logger');

const USER_AGENT_MOZILLA = 'Mozilla/5.0 (Linux; Android 4.1.1; Galaxy Nexus Build/JRO03C) AppleWebKit/535.19 (KHTML, like Gecko) Chrome/18.0.1025.166 Mobile Safari/535.19';

const SUPPORTED_LANGUAGES = ['en', 'de', 'fr', 'it', 'es', 'sv', 'nl', 'no', 'cs', 'sk', 'hu', 'da', 'pl', 'fi', 'pt'];

const wait = promisify(setTimeout);

class KiaUvoApiEU extends ApiImplType1 {
  constructor(region, brand, language, { logger } = {}) {
    super();
    this.logger = prefixLogger(logger, 'KiaUvoApiEU');
    this.dataTimezone = 'Europe/Berlin';
    // equivalent to Python's tuple(x * 0.5 for x in range(28, 60)) -> 14.0..29.5
    this.temperatureRange = Array.from({ length: 32 }, (_, i) => (28 + i) * 0.5);

    let lang = (language || 'en').toLowerCase().slice(0, 2);
    if (!SUPPORTED_LANGUAGES.includes(lang)) lang = 'en';
    this.LANGUAGE = lang;
    this.brand = brand;

    if (brand === BRAND_KIA) {
      this.BASE_DOMAIN = 'prd.eu-ccapi.kia.com';
      this.PORT = 8080;
      this.CCSP_SERVICE_ID = 'fdc85c00-0a2f-4c64-bcb4-2cfb1500730a';
      this.CCS_SERVICE_SECRET = 'secret';
      this.APP_ID = 'a2b8469b-30a3-4361-8e13-6fceea8fbe74';
      this.CFB = Buffer.from('wLTVxwidmH8CfJYBWSnHD6E0huk0ozdiuygB4hLkM5XCgzAL1Dk5sE36d/bx5PFMbZs=', 'base64');
      this.BASIC_AUTHORIZATION = 'Basic ZmRjODVjMDAtMGEyZi00YzY0LWJjYjQtMmNmYjE1MDA3MzBhOnNlY3JldA==';
      this.LOGIN_FORM_HOST = 'https://idpconnect-eu.kia.com';
      this.PUSH_TYPE = 'APNS';
    } else if (brand === BRAND_HYUNDAI) {
      this.BASE_DOMAIN = 'prd.eu-ccapi.hyundai.com';
      this.PORT = 8080;
      this.CCSP_SERVICE_ID = '6d477c38-3ca4-4cf3-9557-2a1929a94654';
      this.CCS_SERVICE_SECRET = 'KUy49XxPzLpLuoK0xhBC77W6VXhmtQR9iQhmIFjjoY4IpxsV';
      this.APP_ID = '014d2225-8495-4735-812d-2616334fd15d';
      this.CFB = Buffer.from('RFtoRq/vDXJmRndoZaZQyfOot7OrIqGVFj96iY2WL3yyH5Z/pUvlUhqmCxD2t+D65SQ=', 'base64');
      this.BASIC_AUTHORIZATION = 'Basic NmQ0NzdjMzgtM2NhNC00Y2YzLTk1NTctMmExOTI5YTk0NjU0OktVeTQ5WHhQekxwTHVvSzB4aEJDNzdXNlZYaG10UVI5aVFobUlGampvWTRJcHhzVg==';
      this.LOGIN_FORM_HOST = 'https://idpconnect-eu.hyundai.com';
      this.PUSH_TYPE = 'GCM';
    } else {
      throw new Error(`Unsupported brand for KiaUvoApiEU: ${brand}`);
    }

    this.BASE_URL = `${this.BASE_DOMAIN}:${this.PORT}`;
    this.USER_API_URL = `https://${this.BASE_URL}/api/v1/user/`;
    this.SPA_API_URL = `https://${this.BASE_URL}/api/v1/spa/`;
    this.SPA_API_URL_V2 = `https://${this.BASE_URL}/api/v2/spa/`;
    this.CLIENT_ID = this.CCSP_SERVICE_ID;

    this._oauthRedirectUri = brand === BRAND_KIA
      ? `${this.USER_API_URL}oauth2/redirect`
      : `${this.USER_API_URL}oauth2/token`;

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
    await this._setSessionLanguage(cookies);

    const isRefreshToken = /^[A-Z0-9]{48}$/.test(password);

    let accessToken;
    let refreshToken;
    let expiresIn;
    if (isRefreshToken) {
      refreshToken = password;
      [, accessToken, , expiresIn] = await this._getAccessToken(stamp, refreshToken);
    } else {
      ({ accessToken, refreshToken, expiresIn } = await this._loginWithPassword(username, password));
    }

    const token = new Token({
      username,
      password,
      pin,
      accessToken,
      refreshToken,
      deviceId,
      validUntil: new Date(Date.now() + expiresIn * 1000),
    });
    return token;
  }

  // NOTE (to verify during live EU validation): Node's fetch with
  // redirect:'follow' only returns the headers of the FINAL response, so
  // Set-Cookie headers on intermediate redirect hops (step 1 below) aren't
  // picked up by the cookie jar — Python's requests.Session does pick them
  // up. If login fails on a missing session cookie, this is the first place
  // to fix (self-follow with redirect:'manual' + manual cookie accumulation
  // per hop).
  async _loginWithPassword(username, password) {
    const host = this.LOGIN_FORM_HOST;
    const clientId = this.CCSP_SERVICE_ID;
    const clientSecret = this.CCS_SERVICE_SECRET;
    const redirectUri = this._oauthRedirectUri;
    const mobileUa = `${USER_AGENT_MOZILLA}_CCS_APP_AOS`;

    const s = new ApiImplSession({ logger: this.logger });
    const baseHeaders = { 'User-Agent': mobileUa };

    // Step 1: load the authorize page for session cookies
    const authUrl = `${host}/auth/api/v2/user/oauth2/authorize?response_type=code&client_id=${clientId}`
      + `&redirect_uri=${redirectUri}&lang=en&state=ccsp&country=de`;
    await s.get(authUrl, { headers: baseHeaders });

    // Step 2: fetch the RSA public key for password encryption
    const certsRes = await s.get(`${host}/auth/api/v1/accounts/certs`, { headers: baseHeaders });
    if (certsRes.status !== 200) {
      throw new AuthenticationError(`API error: failed to fetch RSA certs: HTTP ${certsRes.status}. This may indicate a Hyundai API change.`);
    }
    const certsBody = await certsRes.json();
    const jwk = certsBody.retValue || {};
    const kid = jwk.kid || '';
    const publicKey = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    const encryptedPw = crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(password, 'utf8'),
    ).toString('hex');

    // Step 3: POST signin with encrypted password
    const signinRes = await s.postForm(`${host}/auth/account/signin`, {
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

    if (signinRes.status !== 302) {
      const text = await signinRes.text().catch(() => '');
      throw new AuthenticationError(`Signin failed: HTTP ${signinRes.status} — ${text.slice(0, 300)}. Check username and password.`);
    }

    const location = signinRes.headers.get('location') || '';
    const locationUrl = new URL(location, host);
    const code = locationUrl.searchParams.get('code');
    if (!code) {
      const lower = location.toLowerCase();
      if (lower.includes('error')) {
        const errorDesc = locationUrl.searchParams.get('error_description') || 'unknown';
        throw new AuthenticationError(`Authentication rejected: ${errorDesc}. Check username and password.`);
      }
      if (location.includes('/web/v1/user/authorization')) {
        throw new ConsentRequiredError('Account consent is required. Please log in via a browser once to accept the terms, then use the refresh token.');
      }
      if (location.includes('authorize')) {
        throw new AuthenticationError('Authentication failed — returned to login page. Check username and password.');
      }
      throw new AuthenticationError(`API error: unexpected redirect after signin: ${location.slice(0, 250)}`);
    }

    // Step 4: exchange the authorization code for tokens
    const tokenRes = await s.postForm(`${host}/auth/api/v2/user/oauth2/token`, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }, { headers: baseHeaders });

    if (tokenRes.status !== 200) {
      const text = await tokenRes.text().catch(() => '');
      throw new AuthenticationError(`API error: token exchange failed: HTTP ${tokenRes.status} — ${text.slice(0, 200)}. This may indicate a Hyundai API change.`);
    }
    const tokens = await tokenRes.json();
    return {
      accessToken: `${tokens.token_type} ${tokens.access_token}`,
      refreshToken: tokens.refresh_token,
      expiresIn: Number(tokens.expires_in || 86400),
    };
  }

  async refreshAccessToken(token) {
    if (token.refreshToken) {
      try {
        const stamp = this._getStamp();
        const [, accessToken, newRefreshToken, expiresIn] = await this._getAccessToken(stamp, token.refreshToken);
        return new Token({
          username: token.username,
          password: token.password,
          pin: token.pin,
          accessToken,
          refreshToken: newRefreshToken || token.refreshToken,
          deviceId: token.deviceId,
          validUntil: new Date(Date.now() + expiresIn * 1000),
        });
      } catch (error) {
        // fall back to a full login, just like upstream
      }
    }
    return this.login(token.username, token.password, token.pin);
  }

  async updateVehicleWithCachedState(token, vehicleConfig) {
    const isCcs2 = !!vehicleConfig.ccuCCS2ProtocolSupport;
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}${isCcs2 ? '/ccs2/carstatus/latest' : '/status/latest'}`;
    const response = await this.session.getJson(url, {
      headers: this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport),
    });
    checkResponseForErrors(response);

    if (isCcs2) {
      return response.resMsg.state.Vehicle;
    }
    const result = response.resMsg.vehicleStatusInfo;
    await this._mergeCachedLocationPark(token, vehicleConfig, result);
    return result;
  }

  async forceRefreshVehicleState(token, vehicleConfig) {
    if (vehicleConfig.ccuCCS2ProtocolSupport) {
      return this._forceRefreshVehicleStateCcs2(token, vehicleConfig);
    }
    const state = await this._getForcedVehicleState(token, vehicleConfig);
    const gpsDetail = await this.getLocation(token, vehicleConfig);
    if (gpsDetail) state.vehicleLocation = { coord: gpsDetail.coord };
    return state;
  }

  async _forceRefreshVehicleStateCcs2(token, vehicleConfig) {
    // Wakes the car, waits (~25s measured live) for the car to report in,
    // and then reads the now-fresh cached snapshot — see KiaUvoApiEU.py for
    // why the trigger response itself isn't directly usable.
    const headers = this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport);
    const triggerUrl = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/ccs2/carstatus`;
    await this.session.getJson(triggerUrl, { headers });
    await wait(25 * 1000);
    const response = await this.session.getJson(`${triggerUrl}/latest`, { headers });
    checkResponseForErrors(response);
    return response.resMsg.state.Vehicle;
  }

  async _mergeCachedLocationPark(token, vehicleConfig, result) {
    try {
      const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/location/park`;
      const response = await this.session.getJson(url, { headers: this._getAuthenticatedHeaders(token) });
      checkResponseForErrors(response);
      const location = response.resMsg;
      if (location && getChildValue(location, 'coord.lat') !== undefined) {
        result.vehicleLocation = result.vehicleLocation || {};
        result.vehicleLocation.coord = location.coord;
      }
    } catch (error) {
      // best-effort, just like upstream (_set_cached_location_park swallows errors)
    }
  }

  async getLocation(token, vehicleConfig) {
    try {
      const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/location`;
      const response = await this.session.getJson(url, {
        headers: this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport),
      });
      checkResponseForErrors(response);
      return response.resMsg.gpsDetail || null;
    } catch (error) {
      return null;
    }
  }

  async _getForcedVehicleState(token, vehicleConfig) {
    const url = `${this.SPA_API_URL}vehicles/${vehicleConfig.id}/status`;
    const response = await this.session.getJson(url, {
      headers: this._getAuthenticatedHeaders(token, vehicleConfig.ccuCCS2ProtocolSupport),
    });
    checkResponseForErrors(response);
    return { vehicleStatus: response.resMsg };
  }

  async chargePortAction(token, vehicleConfig, action) {
    const url = `${this.SPA_API_URL_V2}vehicles/${vehicleConfig.id}/control/portdoor`;
    const payload = { action: action === CHARGE_PORT_ACTION.OPEN ? 'open' : 'close' };
    const response = await this.session.postJsonExpectJson(url, payload, {
      headers: await this._getControlHeaders(token, vehicleConfig),
    });
    checkResponseForErrors(response);
    return response.msgId;
  }

  // Port of _get_odometer-equivalent behavior: there's no separate odometer
  // endpoint in the EU API, so this reads it from the cached status.
  async odometer(token, vehicleConfig) {
    const state = await this.updateVehicleWithCachedState(token, vehicleConfig);
    if (vehicleConfig.ccuCCS2ProtocolSupport) {
      return { value: getChildValue(state, 'Drivetrain.Odometer') };
    }
    return state.odometer;
  }

  _getStamp() {
    return xorStamp(this.CFB, this.APP_ID);
  }

  async _getDeviceId(stamp) {
    const registrationId = crypto.randomBytes(32).toString('hex');
    const url = `${this.SPA_API_URL}notifications/register`;
    const payload = {
      pushRegId: registrationId,
      pushType: this.PUSH_TYPE,
      uuid: crypto.randomUUID(),
    };
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
    const url = `${this.USER_API_URL}oauth2/authorize?response_type=code&state=test&client_id=`
      + `${this.CLIENT_ID}&redirect_uri=${this.USER_API_URL}oauth2/redirect&lang=${this.LANGUAGE}`;
    const session = new ApiImplSession({ logger: this.logger });
    await session.get(url);
    return Object.fromEntries(session.cookies);
  }

  async _getAccessToken(stamp, authorizationCode) {
    const url = `${this.LOGIN_FORM_HOST}/auth/api/v2/user/oauth2/token`;
    const response = await this.session.postFormExpectJson(url, {
      grant_type: 'refresh_token',
      refresh_token: authorizationCode,
      client_id: this.CCSP_SERVICE_ID,
      client_secret: this.CCS_SERVICE_SECRET,
    }, { redirect: 'manual' });
    checkResponseForErrors(response);
    const tokenType = response.token_type;
    const accessToken = `${tokenType} ${response.access_token}`;
    const refreshToken = response.refresh_token || authorizationCode;
    const expiresIn = response.expires_in;
    return [tokenType, accessToken, refreshToken, expiresIn];
  }

  async _setSessionLanguage(cookies) {
    const url = `${this.USER_API_URL}language`;
    await this.session.postJson(url, { lang: this.LANGUAGE }, { cookies });
  }
}

module.exports = KiaUvoApiEU;
