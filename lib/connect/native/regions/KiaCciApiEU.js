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

// Port of KiaCciApiEU.py — Kia EU CCI/GSPA API. Login, token lifecycle, the
// GSPA secure-request layer and all commands are inherited from
// ../GspaApiEU.js. Remote actions are gated: only the live-verified endpoints
// in GSPA_VERIFIED_ENDPOINTS pass, force refresh is not implemented (as
// upstream), and action-status polling stays gated (it returned PENDING for
// every poll upstream; outcomes arrive via the cached state read). Driving
// info/history and breakdowns are Hyundai-only, as upstream.

const GspaApiEU = require('../GspaApiEU');

class KiaCciApiEU extends GspaApiEU {
  // Fetch GSPA stored-status. Same response shape as Hyundai EU CCI
  // (state.Vehicle in CCS2 nested format). Unlike Hyundai, driving info and
  // history are not fetched: on Kia these endpoints currently fail
  // server-side (confirmed upstream on a real EV6).
  async updateVehicleWithCachedState(token, vehicleConfig) {
    return this._cachedCcs2State(token, vehicleConfig);
  }
}

// Brand constants (Kia OneApp EU, confirmed upstream on production endpoints).
Object.assign(KiaCciApiEU.prototype, {
  // Verified upstream in the 2026-10 vehicle run (EV6, EV3, eNiro 2021,
  // Inster 2026; doors, climate and lamp also on a PV5/EV6): door
  // lock/unlock (granular endpoints plus the legacy "door" shape), climate
  // ("temperature"), lamp, hazard lights ("light"), horn + hazard
  // ("hornlight"), charge start/stop, and windows via the scope-based
  // "windowcurtain" endpoint. tempUnit must be a string ("C"/"F").
  GSPA_VERIFIED_ENDPOINTS: new Set([
    'door',
    'door-lock',
    'door-unlock',
    'temperature',
    'lamp',
    'light',
    'hornlight',
    'charge',
    'windowcurtain',
  ]),
  supportsWindowControl: true,
  ONEAPP_CLIENT_ID: '01b36c86-79e8-486c-8009-15f2ad88d670',
  ONEAPP_REDIRECT_URI: 'https://oneapp.kia.com/redirect',
  CCI_API_URL: 'https://cci-api-eu.kia.com',
  CCI_PACKAGE_ID: 'com.kia.oneapp.eu',
  GSPA_BASE_URL: 'https://gspa-ccs-eu.kia.com/',
  LOGIN_FORM_HOST: 'https://idpconnect-eu.kia.com',
  CIPHER_BRAND: 'kia',
  REQUEST_ID_HEADER: 'X-Request-Id',
  DEVICE_ID_HEADER: 'X-Userdevice-Id',
});

module.exports = KiaCciApiEU;
