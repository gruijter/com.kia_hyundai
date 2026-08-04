'use strict';

const https = require('https');
const zlib = require('zlib');
const { RequestTimeoutError } = require('./exceptions');
const { normalizeLogger, redactBodyString } = require('./logger');

const USER_AGENT_OK_HTTP = 'okhttp/3.12.0';
const REQUEST_TIMEOUT_MS = 30 * 1000;

// Poort van ApiImpl.py#ApiImplSession: een lichte HTTP-sessie met cookie-jar
// (nodig voor de meerstaps EU-loginflow) en een timeout die als
// RequestTimeoutError naar boven komt, net als upstream.
// Minimale fetch-Response-achtige wrapper rond Node's ingebouwde https-module,
// nodig voor regio's die een https.Agent met niet-standaard TLS-opties vereisen
// (bv. Kia/Hyundai USA's verlaagde cipher-securitylevel) — Node's fetch/undici
// accepteert geen klassiek https.Agent, alleen een eigen Dispatcher (die een
// extra dependency zou vereisen). Dekt alleen wat regions/KiaUvoApiUSA.js nodig
// heeft: status, headers.get(), json(), text().
function httpsRequestWithAgent(agent, method, url, { headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const { hostname, pathname, search } = new URL(url);
    const req = https.request({
      agent,
      method,
      hostname,
      path: `${pathname}${search}`,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        // Node's https-module decomprimeert de body niet automatisch (in
        // tegenstelling tot fetch/undici) — moet hier zelf, anders krijgen
        // regio's die Accept-Encoding: gzip sturen (o.a. Kia/Hyundai USA)
        // ruwe gzip/br-bytes terug i.p.v. JSON.
        const raw = Buffer.concat(chunks);
        let text;
        try {
          const encoding = (res.headers['content-encoding'] || '').toLowerCase();
          if (encoding.includes('br')) text = zlib.brotliDecompressSync(raw).toString('utf8');
          else if (encoding.includes('gzip')) text = zlib.gunzipSync(raw).toString('utf8');
          else if (encoding.includes('deflate')) text = zlib.inflateSync(raw).toString('utf8');
          else text = raw.toString('utf8');
        } catch (error) {
          text = raw.toString('utf8'); // best-effort fallback, blijft loggable
        }
        resolve({
          status: res.statusCode,
          headers: {
            get: (name) => res.headers[name.toLowerCase()],
            // Node normalizeert 'set-cookie' altijd naar een array (ook bij
            // 1 header) omdat losse Set-Cookie-waarden niet veilig met een
            // scheidingsteken samen te voegen zijn — zelfde reden waarom
            // fetch's Headers een aparte getSetCookie() heeft. storeCookies()
            // hieronder verwacht die vorm, niet de gewone .get().
            getSetCookie: () => {
              const raw = res.headers['set-cookie'];
              if (!raw) return [];
              return Array.isArray(raw) ? raw : [raw];
            },
          },
          json: async () => JSON.parse(text),
          text: async () => text,
        });
      });
    });
    req.on('timeout', () => req.destroy(new RequestTimeoutError(`${method} ${url} timed out`)));
    req.on('error', (error) => reject(error instanceof RequestTimeoutError ? error : error));
    if (body) req.write(body);
    req.end();
  });
}

class ApiImplSession {
  // httpsAgent: optionele node:https Agent voor niet-standaard TLS-eisen
  // (bv. Kia/Hyundai USA's SECLEVEL=1 cipher-vereiste, zie
  // regions/KiaUvoApiUSA.js). Wanneer gezet wordt Node's https-module
  // gebruikt i.p.v. fetch, want fetch/undici accepteert geen klassiek
  // https.Agent.
  // logger: { log, error } (meestal Homey's this.log/this.error, doorgegeven
  // vanaf device.js/driver.js) — elke request/response wordt hierop gelogd
  // zodat niet-EU-regio's te debuggen zijn via Homey's diagnostic reports,
  // zie ../NAMING.md en ../logger.js. Nooit wachtwoorden/tokens/PINs: alle
  // gelogde bodies gaan door redactBodyString().
  constructor({ httpsAgent, logger } = {}) {
    this.cookies = new Map();
    this.httpsAgent = httpsAgent;
    this.logger = normalizeLogger(logger);
  }

  cookieHeader() {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    let setCookies = [];
    if (typeof res.headers.getSetCookie === 'function') {
      setCookies = res.headers.getSetCookie();
    } else if (res.headers.get('set-cookie')) {
      setCookies = [res.headers.get('set-cookie')];
    }
    setCookies.forEach((raw) => {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    });
  }

  // redirect: 'follow' (default) | 'manual' (needed to read a 302 Location
  // header without Node following it, e.g. the EU signin step)
  async request(method, url, {
    headers = {}, body, redirect = 'follow', cookies,
  } = {}) {
    const finalHeaders = { 'User-Agent': USER_AGENT_OK_HTTP, ...headers };
    const cookieHeader = cookies
      ? Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
      : this.cookieHeader();
    if (cookieHeader) finalHeaders.Cookie = cookieHeader;

    const logPath = `${method} ${new URL(url).pathname}`;
    this.logger.log(`→ ${logPath}`);

    let res;
    try {
      if (this.httpsAgent) {
        res = await httpsRequestWithAgent(this.httpsAgent, method, url, { headers: finalHeaders, body });
      } else {
        res = await fetch(url, {
          method, headers: finalHeaders, body, redirect, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      }
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        this.logger.error(`✗ ${logPath}: timed out after ${REQUEST_TIMEOUT_MS}ms`);
        throw new RequestTimeoutError(`${method} ${url} timed out`);
      }
      this.logger.error(`✗ ${logPath}: ${error.message}`);
      throw error;
    }
    this.storeCookies(res);

    // Body altijd loggen (getruncateerd/geredigeerd): veel van deze API's
    // coderen fouten in een 200-OK JSON-body (retCode/resCode/responseCode)
    // i.p.v. via de HTTP-status, dus alleen op status>=400 loggen zou de
    // meeste API-fouten missen. Bij fetch via een clone lezen zodat de
    // response zelf nog leesbaar blijft voor de aanroeper.
    try {
      const bodyText = this.httpsAgent ? await res.text() : await res.clone().text();
      const logLine = `← ${res.status} ${logPath}: ${redactBodyString(bodyText)}`;
      if (res.status >= 400) this.logger.error(logLine);
      else this.logger.log(logLine);
    } catch (error) {
      this.logger.log(`← ${res.status} ${logPath} (body unreadable for logging: ${error.message})`);
    }

    return res;
  }

  get(url, opts) {
    return this.request('GET', url, opts);
  }

  async getJson(url, opts) {
    const res = await this.get(url, opts);
    return res.json();
  }

  postJson(url, payload, opts = {}) {
    return this.request('POST', url, {
      ...opts,
      headers: { 'Content-Type': 'application/json;charset=UTF-8', ...opts.headers },
      body: JSON.stringify(payload),
    });
  }

  async postJsonExpectJson(url, payload, opts) {
    const res = await this.postJson(url, payload, opts);
    return res.json();
  }

  postForm(url, form, opts = {}) {
    return this.request('POST', url, {
      ...opts,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...opts.headers },
      body: new URLSearchParams(form).toString(),
    });
  }

  async postFormExpectJson(url, form, opts) {
    const res = await this.postForm(url, form, opts);
    return res.json();
  }

  put(url, opts) {
    return this.request('PUT', url, opts);
  }

  async putJsonExpectJson(url, payload, opts = {}) {
    const res = await this.request('PUT', url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(payload),
    });
    return res.json();
  }
}

module.exports = { ApiImplSession, USER_AGENT_OK_HTTP };
