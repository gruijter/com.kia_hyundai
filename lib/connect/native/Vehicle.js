'use strict';

// Adapter zonder Python-equivalent: vertaalt VehicleManager-aanroepen naar de
// bluelinky-vormige methode-surface die drivers/car/driver.js en device.js al
// gebruiken (status/fullStatus/location/odometer/start/stop/lock/unlock/
// startCharge/stopCharge/setChargeTargets/setNavigation), zodat die bestanden
// bij de overstap op de native helper vrijwel ongewijzigd blijven. Zie ../NAMING.md.
class Vehicle {
  constructor(manager, vehicleConfig) {
    this.manager = manager;
    this.vehicleConfig = vehicleConfig;
  }

  // ccuCCS2-auto's: geeft de raw CCS2 "Vehicle" state terug.
  async status({ refresh = false } = {}) {
    return refresh
      ? this.manager.forceRefreshVehicleState(this.vehicleConfig)
      : this.manager.updateVehicleWithCachedState(this.vehicleConfig);
  }

  // non-ccuCCS2 EU-auto's: geeft {vehicleStatus, vehicleLocation, odometer} terug.
  // Zelfde onderliggende call als status() — de regio-implementatie bepaalt zelf
  // welke vorm terugkomt op basis van vehicleConfig.ccuCCS2ProtocolSupport.
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

  // fast -> DC (rapid) doel, slow -> AC (Type2) doel — zie ../NAMING.md.
  setChargeTargets({ fast, slow } = {}) {
    return this.manager.setChargeLimits(this.vehicleConfig, slow, fast);
  }

  // poiList: array met 1 POI-object, al in de juiste vorm gebouwd door device.js.
  setNavigation(poiList) {
    return this.manager.setNavigation(this.vehicleConfig, poiList);
  }
}

module.exports = Vehicle;
