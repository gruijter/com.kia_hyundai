'use strict';

const { RequestTimeoutError } = require('./exceptions');

const USER_AGENT_OK_HTTP = 'okhttp/3.12.0';
const REQUEST_TIMEOUT_MS = 30 * 1000;

// Poort van ApiImpl.py#ApiImplSession: een lichte HTTP-sessie met cookie-jar
// (nodig voor de meerstaps EU-loginflow) en een timeout die als
// RequestTimeoutError naar boven komt, net als upstream.
class ApiImplSession {
  constructor() {
    this.cookies = new Map();
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
      res = await fetch(url, {
        method, headers: finalHeaders, body, redirect, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
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
