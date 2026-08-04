'use strict';

const https = require('https');
const { RequestTimeoutError } = require('./exceptions');

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
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: { get: (name) => res.headers[name.toLowerCase()] },
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
  constructor({ httpsAgent } = {}) {
    this.cookies = new Map();
    this.httpsAgent = httpsAgent;
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
        throw new RequestTimeoutError(`${method} ${url} timed out`);
      }
      throw error;
    }
    this.storeCookies(res);
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
