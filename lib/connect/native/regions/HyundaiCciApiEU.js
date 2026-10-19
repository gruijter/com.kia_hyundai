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

// Port of HyundaiCciApiEU.py — Hyundai EU CCI/GSPA API. Login, token
// lifecycle and the GSPA secure-request layer are inherited from
// ../GspaApiEU.js, as are all commands (live-verified upstream on Hyundai, so
// not gated). Hyundai-only reads: driving info/history and breakdowns.
// Like every region here these return raw JSON; upstream's parsers into its
// Vehicle (_update_vehicle_drive_info, _update_vehicle_driving_history,
// _parse_breakdowns, _update_vehicle_gspa_data) are not ported, see
// ../../NAMING.md.

const GspaApiEU = require('../GspaApiEU');

class HyundaiCciApiEU extends GspaApiEU {
  // ------------------------------------------------------------------
  // Driving info + history (GSPA, read-only)
  // ------------------------------------------------------------------

  // Driving info from the GSPA driving-info endpoint, or null.
  async _getDrivingInfo(token, vehicleConfig) {
    this._validateCcsToken(token);
    try {
      return await this._gspaGet(token, vehicleConfig, 'driving-info/vehicles/{carId}');
    } catch {
      this.logger.log('GSPA driving-info failed');
      return null;
    }
  }

  // 30-day driving history from the GSPA driving-history endpoint, or null.
  async _getDrivingHistory(token, vehicleConfig) {
    this._validateCcsToken(token);
    try {
      return await this._gspaGet(token, vehicleConfig, 'driving-history/vehicles/{carId}');
    } catch {
      this.logger.log('GSPA driving-history failed');
      return null;
    }
  }

  // ------------------------------------------------------------------
  // DTC breakdowns (GSPA, read-only)
  // ------------------------------------------------------------------

  // Diagnostic trouble codes: {"breakdown": [{"ecuName", "ecuIdx", "dtcList"}]}, or null.
  async getBreakdowns(token, vehicleConfig) {
    this._validateCcsToken(token);
    try {
      return await this._gspaGet(token, vehicleConfig, 'diagnostics/vehicles/{carId}/breakdowns');
    } catch {
      this.logger.log('GSPA breakdowns failed');
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Force refresh
  // ------------------------------------------------------------------

  // Wake the vehicle and re-read GSPA stored-status. Prewakeup is best-effort
  // (the car may be offline); the status read returns the last cached state
  // regardless.
  async forceRefreshVehicleState(token, vehicleConfig) {
    this._validateCcsToken(token);
    try {
      await this.prewakeup(token, vehicleConfig);
    } catch {
      this.logger.log('prewakeup failed (car may be offline)');
    }
    return this.updateVehicleWithCachedState(token, vehicleConfig);
  }

  // Fetch GSPA stored-status: {serviceNo, lastUpdateTime, state: {Vehicle:
  // {Body, Cabin, Chassis, Drivetrain, Green, Electronics, Location, ...}}}.
  // Upstream then also reads driving info/history (EV/PHEV) and the
  // software-version/OTA queries into its Vehicle; here those are separate
  // raw calls (_getDrivingInfo, _getDrivingHistory, getSoftwareVersion,
  // getOtaUpdates).
  async updateVehicleWithCachedState(token, vehicleConfig) {
    return this._cachedCcs2State(token, vehicleConfig);
  }
}

// Brand constants (Hyundai OneApp EU, confirmed upstream on production endpoints).
Object.assign(HyundaiCciApiEU.prototype, {
  supportsSvm: true,
  supportsWindowControl: true,
  GSPA_REMOTE_CONTROL_VERIFIED: true,
  ONEAPP_CLIENT_ID: '4f4953b5-02e1-4dbc-8599-87e983ee1be5',
  ONEAPP_REDIRECT_URI: 'https://oneapp.hyundai.com/redirect',
  CCI_API_URL: 'https://cci-api-eu.hyundai.com',
  CCI_PACKAGE_ID: 'com.hyundai.oneapp.eu',
  GSPA_BASE_URL: 'https://gspa-ccs-eu.hyundai.com/',
  LOGIN_FORM_HOST: 'https://idpconnect-eu.hyundai.com',
  CIPHER_BRAND: 'hyundai',
  REQUEST_ID_HEADER: 'X-Request-Id',
  DEVICE_ID_HEADER: 'X-Device-Id',
});

module.exports = HyundaiCciApiEU;
