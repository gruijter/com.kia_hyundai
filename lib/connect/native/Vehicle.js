'use strict';

// Adapter with no Python equivalent: translates VehicleManager calls into
// the bluelinky-shaped method surface that drivers/car/driver.js and
// device.js already use (status/fullStatus/location/odometer/start/stop/
// lock/unlock/startCharge/stopCharge/setChargeTargets/setNavigation), so
// those files stayed nearly unchanged when switching to the native helper.
// See ../NAMING.md.
class Vehicle {
  constructor(manager, vehicleConfig) {
    this.manager = manager;
    this.vehicleConfig = vehicleConfig;
  }

  // ccuCCS2 vehicles: returns the raw CCS2 "Vehicle" state.
  async status({ refresh = false } = {}) {
    return refresh
      ? this.manager.forceRefreshVehicleState(this.vehicleConfig)
      : this.manager.updateVehicleWithCachedState(this.vehicleConfig);
  }

  // non-ccuCCS2 EU vehicles: returns {vehicleStatus, vehicleLocation, odometer}.
  // Same underlying call as status() — the region implementation decides
  // which shape comes back based on vehicleConfig.ccuCCS2ProtocolSupport.
  async fullStatus(opts) {
    return this.status(opts);
  }

  async location() {
    const gpsDetail = await this.manager.getLocation(this.vehicleConfig);
    return gpsDetail ? { latitude: gpsDetail.coord?.lat, longitude: gpsDetail.coord?.lon } : null;
  }

  odometer() {
    return this.manager.odometer(this.vehicleConfig);
  }

  start(args = {}) {
    return this.manager.startClimate(this.vehicleConfig, {
      setTemp: args.temperature,
      defrost: args.defrost,
      heating: args.heating1,
      steeringWheel: args.steerWheelHeat,
      duration: args.igniOnDuration,
    });
  }

  stop() {
    return this.manager.stopClimate(this.vehicleConfig);
  }

  lock() {
    return this.manager.lock(this.vehicleConfig);
  }

  unlock() {
    return this.manager.unlock(this.vehicleConfig);
  }

  startCharge() {
    return this.manager.startCharge(this.vehicleConfig);
  }

  stopCharge() {
    return this.manager.stopCharge(this.vehicleConfig);
  }

  // fast -> DC (rapid) target, slow -> AC (Type2) target — see ../NAMING.md.
  setChargeTargets({ fast, slow } = {}) {
    return this.manager.setChargeLimits(this.vehicleConfig, slow, fast);
  }

  // poiList: array with 1 POI object, already built in the right shape by device.js.
  setNavigation(poiList) {
    return this.manager.setNavigation(this.vehicleConfig, poiList);
  }
}

module.exports = Vehicle;
