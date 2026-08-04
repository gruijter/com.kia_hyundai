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

const VehicleManager = require('./native/VehicleManager');
const constants = require('./native/const');
const exceptions = require('./native/exceptions');

const REGION_MAP = {
  EU: constants.REGION_EUROPE,
  US: constants.REGION_USA,
  CA: constants.REGION_CANADA,
  AU: constants.REGION_AUSTRALIA,
  CN: constants.REGION_CHINA,
};
const BRAND_MAP = { kia: constants.BRAND_KIA, hyundai: constants.BRAND_HYUNDAI };

// Maps Homey-side option names (region: 'EU', brand: 'kia') to the Python
// project's region/brand enums and constructs a VehicleManager — the same
// class drivers/car/driver.js and device.js call directly (login/status/
// control methods). No bluelinky-shaped adapter in between: no events, no
// per-vehicle wrapper object — callers get plain vehicleConfig objects back
// from login() and pass them to VehicleManager methods explicitly, exactly
// like the Python VehicleManager is used. See ../NAMING.md.
function createClient({
  username, password, pin, region, brand, language, logger,
}) {
  return new VehicleManager({
    username,
    password,
    pin,
    region: REGION_MAP[region],
    brand: BRAND_MAP[brand],
    language,
    logger,
  });
}

// exceptions: exposed so drivers/car/device.js can recognize error types
// (e.g. AuthenticationError) to show an understandable unavailable message
// instead of the generic "Device is restarting" fallback.
// constants: exposed so device.js can build action enums (CHARGE_PORT_ACTION,
// VALET_MODE_ACTION, WINDOW_STATE) for control commands without reaching
// past this barrel into lib/connect/native/ directly.
module.exports = { createClient, exceptions, constants };
