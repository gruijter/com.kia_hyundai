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

/* eslint-disable no-console, no-process-exit */
/*
 * Standalone validation script for lib/connect (EU implementation), outside
 * the Homey runtime. Logs in, fetches the vehicles, and prints the raw
 * vehicleConfig + status/odometer, so you can check the field names are
 * correct before pairing a real vehicle.
 *
 * Credentials come from zzz_test/env.json (already gitignored, see
 * .gitignore) or from the environment. Usage:
 *
 *   cp zzz_test/env.json.example zzz_test/env.json   # once, then fill it in
 *   node zzz_test/test-eu-connect.js kia
 *   node zzz_test/test-eu-connect.js hyundai
 */

let env = {};
try {
  // eslint-disable-next-line global-require, import/no-unresolved, node/no-missing-require, node/no-unpublished-require
  env = require('./env.json');
} catch (error) {
  env = process.env;
}

const VehicleManager = require('../lib/connect/native/VehicleManager');
const { REGION_EUROPE, BRAND_KIA, BRAND_HYUNDAI } = require('../lib/connect/native/const');

async function main() {
  const brandArg = (process.argv[2] || 'kia').toLowerCase();
  const brand = brandArg === 'hyundai' ? BRAND_HYUNDAI : BRAND_KIA;
  const prefix = brandArg === 'hyundai' ? 'HYUNDAI_EU' : 'KIA_EU';

  const username = env[`${prefix}_USERNAME`];
  const password = env[`${prefix}_PASSWORD`];
  const pin = env[`${prefix}_PIN`];
  if (!username || !password || !pin) {
    console.error(`Missing ${prefix}_USERNAME / ${prefix}_PASSWORD / ${prefix}_PIN in env.json or environment`);
    process.exit(1);
  }

  const manager = new VehicleManager({
    username, password, pin, region: REGION_EUROPE, brand, language: 'en', logger: console,
  });

  console.log(`Logging in as ${brandArg} EU...`);
  const vehicles = await manager.login();
  console.log(`Found ${vehicles.length} vehicle(s):`);
  vehicles.forEach((v) => console.log(JSON.stringify(v, null, 2)));

  if (vehicles.length === 0) return;
  const vehicleConfig = vehicles[0];

  console.log('\nFetching odometer...');
  console.log(JSON.stringify(await manager.odometer(vehicleConfig), null, 2));

  console.log('\nFetching cached status...');
  console.log(JSON.stringify(await manager.updateVehicleWithCachedState(vehicleConfig), null, 2));

  console.log('\nDone. Run with --force-refresh and/or --control to also test');
  console.log('force_refresh_vehicle_state and lock/climate/charge actions.');

  if (process.argv.includes('--force-refresh')) {
    console.log('\nForce-refreshing vehicle state (this wakes the car)...');
    console.log(JSON.stringify(await manager.forceRefreshVehicleState(vehicleConfig), null, 2));
  }

  if (process.argv.includes('--control')) {
    console.log('\nTesting lock...');
    console.log(await manager.lock(vehicleConfig));
    console.log('Testing unlock...');
    console.log(await manager.unlock(vehicleConfig));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
