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

// Port of const.py. Only the constants needed by the ported regions/
// functionality were carried over; extend when porting new regions.

const BRAND_KIA = 'Kia';
const BRAND_HYUNDAI = 'Hyundai';
const BRAND_GENESIS = 'Genesis';

const REGION_EUROPE = 'Europe';
const REGION_CANADA = 'Canada';
const REGION_USA = 'USA';
const REGION_CHINA = 'China';
const REGION_AUSTRALIA = 'Australia';

const VEHICLE_LOCK_ACTION = { LOCK: 'close', UNLOCK: 'open' };
const CHARGE_PORT_ACTION = { CLOSE: 'close', OPEN: 'open' };
const VALET_MODE_ACTION = { ACTIVATE: 'activate', DEACTIVATE: 'deactivate' };
const WINDOW_STATE = { CLOSED: 0, OPEN: 1, VENTILATION: 2 };

// Port of const.py#SEAT_STATUS/HEAT_STATUS — values accepted by
// startClimate()'s seatClimateInfo (CCS2) and heating/heating1 (legacy)
// options. Only the values this app actually sends are named; see
// upstream const.py for the full meaning of every code (incl. cooling
// levels 3-5, not currently exposed as a Homey option).
const SEAT_STATUS = { OFF: 0, MEDIUM_HEAT: 7 };
const HEAT_STATUS = { OFF: 0, STEERING_WHEEL_AND_REAR_WINDOW: 1, STEERING_WHEEL: 3 };

const ORDER_STATUS = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
};

module.exports = {
  BRAND_KIA,
  BRAND_HYUNDAI,
  BRAND_GENESIS,
  REGION_EUROPE,
  REGION_CANADA,
  REGION_USA,
  REGION_CHINA,
  REGION_AUSTRALIA,
  VEHICLE_LOCK_ACTION,
  CHARGE_PORT_ACTION,
  VALET_MODE_ACTION,
  WINDOW_STATE,
  ORDER_STATUS,
  SEAT_STATUS,
  HEAT_STATUS,
};
