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

// Port of gspa/cipher_keys.py — GSPA X-Stamp cipher: AES-128 with
// per-parameter affine layers, driven by per-brand tables. The JSON tables
// are upstream's, compacted (same data). Lookups XOR 32-bit words, which JS
// keeps as signed int32; every consumer masks down to a byte, so the sign
// never matters.

const crypto = require('crypto');

const SR_POSITIONS = [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11];
const TSID_EPOCH_MS = Date.UTC(2020, 0, 1);

// Region IVs (public 16-byte ASCII strings).
const IVS = {
  1: Buffer.from('iv.ccsp.stamp.eu'), // EU
  2: Buffer.from('iv.ccsp.stamp.sa'), // SA
  4: Buffer.from('iv.ccsp.stamp.us'), // US
  5: Buffer.from('iv.ccsp.stamp.ca'), // CA
  9: Buffer.from('iv.ccsp.stamp.jp'), // JP
};

function _loadJson(filename) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(`./${filename}`);
}

// Per-brand cipher configuration. Each brand specifies its parameter
// table file, optional mask LUT file, round-phase plan [sboxGroup,
// linearGroup, roundCount], and the final-round group name.
const BRAND_CIPHER_SPECS = {
  hyundai: {
    paramsFile: 'hyundai_cipher_params.json',
    masks: null,
    phases: [['X4', 'X27', 8], ['GAP', 'POST_X27', 5]],
    finalGroup: 'X8',
  },
  kia: {
    paramsFile: 'kia_cipher_params.json',
    masks: 'kia_mask_luts.json',
    phases: [['SBOX', 'LINEAR', 13]],
    finalGroup: 'BYTE',
  },
};

function _mat(cols, x) {
  let y = 0;
  let i = 0;
  while (x) {
    if (x & 1) y ^= cols[i];
    x >>>= 1;
    i += 1;
  }
  return y;
}

function _lapply(cols, c) {
  let v = 0;
  let i = 0;
  while (c) {
    if (c & 1) v ^= cols[i];
    c >>>= 1;
    i += 1;
  }
  return v;
}

const _hex = (c) => parseInt(c, 16);

function createTsid(deviceIdHex = '', counter = 0) {
  const tsOffset = Date.now() - TSID_EPOCH_MS;
  const packed = Buffer.alloc(8);
  packed.writeBigUInt64BE(BigInt(tsOffset));
  const tsBytes = packed.subarray(3);
  const nodeBytes = deviceIdHex
    ? Buffer.from(deviceIdHex.replace(/-/g, '').slice(0, 16), 'hex')
    : crypto.randomBytes(8);
  const lastByte = (((counter & 0x0F) << 4) | ((counter >> 4) & 0x0F)) | 6;
  return Buffer.concat([tsBytes, nodeBytes, Buffer.from([lastByte])])
    .toString('base64')
    .replace(/=+$/, '');
}

class GspaCipher {

  constructor(params = null, masks = null, spec = null) {
    if (params === null) {
      // Default constructor: load the parameter set for the given spec (or
      // Hyundai, so that `new GspaCipher()` works as upstream's GspaCipher()).
      spec = spec || BRAND_CIPHER_SPECS.hyundai;
      params = _loadJson(spec.paramsFile);
      if (masks === null && spec.masks) masks = _loadJson(spec.masks);
    }
    this._spec = spec || BRAND_CIPHER_SPECS.hyundai;
    this.p = params;
    this.masks = masks;
    this.S = this.p.sbox.map(_hex);
    this.G = {};
    this._parseGroups();
  }

  _parseGroups() {
    // Sbox-style groups: {M1, a, M2, t2, Lcols, c, is_byte}
    // Linear-style groups: {lcols, lconst}
    // Both brands use both schemas; group names differ by brand.
    const first = (g) => {
      const v = this.p[g];
      if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
      const keys = Object.keys(v);
      return keys.length ? v[keys[0]] : {};
    };
    const groups = Object.keys(this.p);
    const sboxGroups = groups.filter((g) => 'M1' in first(g));
    const linGroups = groups.filter((g) => 'lcols' in first(g));
    sboxGroups.forEach((g) => {
      this.G[g] = {};
      Object.entries(this.p[g]).forEach(([sub, p]) => {
        this.G[g][Number(sub)] = {
          M1: p.M1.map(_hex),
          a: p.a,
          M2: p.M2.map(_hex),
          t2: p.t2,
          Lcols: p.Lcols.map(_hex),
          c: p.c,
          is_byte: p.is_byte,
        };
      });
    });
    linGroups.forEach((g) => {
      this.G[g] = {};
      Object.entries(this.p[g]).forEach(([sub, p]) => {
        this.G[g][Number(sub)] = {
          lcols: p.lcols.map(_hex),
          lconst: p.lconst,
        };
      });
    });
    // Parse mask LUTs into int form if present.
    this._masksParsed = null;
    if (this.masks !== null) {
      this._masksParsed = new Map();
      Object.entries(this.masks).forEach(([key, luts]) => {
        // key format: "(r,c)"
        const [rStr, cStr] = key.replace(/^\(|\)$/g, '').split(',');
        this._masksParsed.set(`${Number(rStr)},${Number(cStr)}`, luts.map((lut) => lut.map(Number)));
      });
    }
  }

  _sboxLookup(g, sub, x) {
    const q = this.G[g][sub];
    const a1 = _mat(q.M1, x ^ Number(q.a));
    const s = this.S[a1];
    const a2 = _mat(q.M2, s) ^ Number(q.t2);
    if (q.is_byte) return (Number(q.c) ^ a2) & 0xFF;
    return Number(q.c) ^ _lapply(q.Lcols, a2);
  }

  _linLookup(g, sub, b) {
    const q = this.G[g][sub];
    return Number(q.lconst) ^ _lapply(q.lcols, b);
  }

  // Computes the 32-bit mask word for a round column:
  // mask = g0[b0] ^ g1[b1] ^ g2[b2] ^ g3[b3], b0..b3 being the column's state
  // bytes before the sbox layer. Returns 0 when no masks are loaded. The
  // current Kia parameter set carries all-zero masks.
  _maskByte(globalRound, col, srcBytes) {
    if (this._masksParsed === null) return 0;
    const luts = this._masksParsed.get(`${globalRound},${col}`);
    if (luts === undefined) return 0;
    return luts[0][srcBytes[0]]
      ^ luts[1][srcBytes[1]]
      ^ luts[2][srcBytes[2]]
      ^ luts[3][srcBytes[3]];
  }

  _round(state, sboxGroup, linGroup, rnd, globalRound) {
    state = Buffer.from(SR_POSITIONS.map((pos) => state[pos]));
    const rbase = rnd * 16;
    for (let col = 0; col < 4; col += 1) {
      const base = rbase + col * 4;
      const sbase = col * 4;
      const sboxOut = [0, 1, 2, 3].map((j) => this._sboxLookup(sboxGroup, base + j, state[sbase + j]));
      const inter = sboxOut[0] ^ sboxOut[1] ^ sboxOut[2] ^ sboxOut[3];
      const linOut = [0, 1, 2, 3].map((j) => this._linLookup(linGroup, base + j, (inter >>> (8 * (3 - j))) & 0xFF));
      // Mask layer (brand-specific, no-op when masks absent or zero): the
      // 32-bit mask word derived from the column's pre-sbox state bytes is
      // XORed once into the linear output word.
      const mb = this._maskByte(globalRound, col, [...state.subarray(sbase, sbase + 4)]);
      const out = linOut[0] ^ linOut[1] ^ linOut[2] ^ linOut[3] ^ mb;
      for (let j = 0; j < 4; j += 1) {
        state[sbase + j] = (out >>> (8 * (3 - j))) & 0xFF;
      }
    }
    return state;
  }

  encryptBlock(plaintext16) {
    if (plaintext16.length !== 16) throw new RangeError('Block must be exactly 16 bytes');
    const spec = this._spec;
    let state = Buffer.from(plaintext16);
    let globalRound = 0;
    spec.phases.forEach(([sboxGroup, linGroup, rounds]) => {
      for (let rnd = 0; rnd < rounds; rnd += 1) {
        state = this._round(state, sboxGroup, linGroup, rnd, globalRound);
        globalRound += 1;
      }
    });
    const fg = spec.finalGroup;
    return Buffer.from(SR_POSITIONS.map((pos, k) => this._sboxLookup(fg, k, state[pos]) & 0xFF));
  }

  encryptCfb(iv, plaintext) {
    if (iv.length !== 16) throw new RangeError(`IV must be 16 bytes, got ${iv.length}`);
    const ciphertext = [];
    let feedback = Buffer.from(iv);
    for (let i = 0; i < plaintext.length; i += 16) {
      const enc = this.encryptBlock(feedback);
      const block = plaintext.subarray(i, i + 16);
      const cb = Buffer.from([...block].map((b, k) => enc[k] ^ b));
      ciphertext.push(cb);
      feedback = cb;
    }
    return Buffer.concat(ciphertext).subarray(0, plaintext.length);
  }

  computeXStamp(region = 1, tsid = null, epochSeconds = null, userId = '') {
    if (region === 4 || region === 5) throw new Error('US/CA not supported');
    if (!(region in IVS)) throw new RangeError(`Unknown region ${region}`);
    if (tsid === null) tsid = createTsid();
    if (epochSeconds === null) epochSeconds = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(`${tsid}:${epochSeconds}:${userId}`, 'utf8');
    return this.encryptCfb(IVS[region], payload).toString('base64');
  }

}

// --- Brand factories ---

let _hyundaiCipher = null;
let _kiaCipher = null;

function hyundaiCipher() {
  if (_hyundaiCipher === null) {
    const spec = BRAND_CIPHER_SPECS.hyundai;
    const params = _loadJson(spec.paramsFile);
    const masks = spec.masks ? _loadJson(spec.masks) : null;
    _hyundaiCipher = new GspaCipher(params, masks, spec);
  }
  return _hyundaiCipher;
}

function kiaCipher() {
  if (_kiaCipher === null) {
    const spec = BRAND_CIPHER_SPECS.kia;
    const params = _loadJson(spec.paramsFile);
    const masks = spec.masks ? _loadJson(spec.masks) : null;
    _kiaCipher = new GspaCipher(params, masks, spec);
  }
  return _kiaCipher;
}

// --- Module-level convenience functions (Hyundai, as upstream) ---

function _getCipher() {
  return hyundaiCipher();
}

function encryptBlock(plaintext16) {
  return _getCipher().encryptBlock(plaintext16);
}

// The region argument guards stamp usage only (US/CA unsupported); the IV is
// caller-supplied.
function encryptCfb(iv, plaintext, region = 1) {
  if (region === 4 || region === 5) throw new Error('US/CA not supported — EU-cipher regions only');
  if (!(region in IVS)) throw new RangeError(`Unknown region ${region}`);
  return _getCipher().encryptCfb(iv, plaintext);
}

function computeXStamp(region = 1, tsid = null, epochSeconds = null, userId = '') {
  return _getCipher().computeXStamp(region, tsid, epochSeconds, userId);
}

module.exports = {
  SR_POSITIONS,
  TSID_EPOCH_MS,
  IVS,
  BRAND_CIPHER_SPECS,
  GspaCipher,
  createTsid,
  hyundaiCipher,
  kiaCipher,
  encryptBlock,
  encryptCfb,
  computeXStamp,
};
