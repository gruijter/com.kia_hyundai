'use strict';

/* eslint-disable no-console, no-process-exit */
/*
 * Standalone validatiescript voor lib/connect (EU-implementatie), buiten de
 * Homey-runtime om. Logt in, haalt de auto's op en print raw vehicleConfig +
 * status/odometer, zodat je kunt controleren of de veldnamen kloppen voordat
 * je met een echte auto gaat pairen.
 *
 * Credentials komen uit env.json (al genegeerd door git, zie .gitignore) of
 * uit de omgeving. Gebruik:
 *
 *   cp env.json.example env.json   # eenmalig, en vul 'm in
 *   node scripts/test-eu-connect.js kia
 *   node scripts/test-eu-connect.js hyundai
 */

let env = {};
try {
  // eslint-disable-next-line global-require, import/no-unresolved, node/no-missing-require, node/no-unpublished-require
  env = require('../env.json');
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
