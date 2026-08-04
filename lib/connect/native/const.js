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
  ORDER_STATUS,
};
