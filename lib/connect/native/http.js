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

const https = require('https');
const zlib = require('zlib');
const { RequestTimeoutError } = require('./exceptions');
const { normalizeLogger, redactBodyString } = require('./logger');

const USER_AGENT_OK_HTTP = 'okhttp/3.12.0';
const REQUEST_TIMEOUT_MS = 30 * 1000;

// Port of ApiImpl.py#ApiImplSession: a lightweight HTTP session with a
// cookie jar (needed for the multi-step EU login flow) and a timeout that
// surfaces as RequestTimeoutError, just like upstream.
// Minimal fetch-Response-like wrapper around Node's built-in https module,
// needed for regions that require an https.Agent with non-standard TLS
// options (e.g. Kia/Hyundai USA's lowered cipher security level) — Node's
// fetch/undici doesn't accept a classic https.Agent, only its own Dispatcher
// (which would require an extra dependency). Only covers what
// regions/KiaUvoApiUSA.js needs: status, headers.get(), json(), text().
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
        // Node's https module doesn't decompress the body automatically
        // (unlike fetch/undici) — has to happen here, otherwise regions that
        // send Accept-Encoding: gzip (e.g. Kia/Hyundai USA) get raw gzip/br
        // bytes back instead of JSON.
        const raw = Buffer.concat(chunks);
        let text;
        try {
          const encoding = (res.headers['content-encoding'] || '').toLowerCase();
          if (encoding.includes('br')) text = zlib.brotliDecompressSync(raw).toString('utf8');
          else if (encoding.includes('gzip')) text = zlib.gunzipSync(raw).toString('utf8');
          else if (encoding.includes('deflate')) text = zlib.inflateSync(raw).toString('utf8');
          else text = raw.toString('utf8');
        } catch (error) {
          text = raw.toString('utf8'); // best-effort fallback, stays loggable
        }
        resolve({
          status: res.statusCode,
          headers: {
            get: (name) => res.headers[name.toLowerCase()],
            // Node always normalizes 'set-cookie' to an array (even for 1
            // header) because separate Set-Cookie values can't safely be
            // joined with a delimiter — the same reason fetch's Headers has
            // a separate getSetCookie(). storeCookies() below expects that
            // shape, not the regular .get().
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
  // httpsAgent: optional node:https Agent for non-standard TLS requirements
  // (e.g. Kia/Hyundai USA's SECLEVEL=1 cipher requirement, see
  // regions/KiaUvoApiUSA.js). When set, Node's https module is used instead
  // of fetch, since fetch/undici doesn't accept a classic https.Agent.
  // logger: { log, error } (usually Homey's this.log/this.error, passed
  // down from device.js/driver.js) — every request/response is logged here
  // so non-EU regions can be debugged via Homey diagnostic reports, see
  // ../NAMING.md and ../logger.js. Never passwords/tokens/PINs: all logged
  // bodies go through redactBodyString().
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

    // Always log the body (truncated/redacted): many of these APIs encode
    // errors in a 200-OK JSON body (retCode/resCode/responseCode) instead of
    // via the HTTP status, so only logging on status>=400 would miss most
    // API errors. Read via a clone for fetch, so the response itself stays
    // readable for the caller.
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
