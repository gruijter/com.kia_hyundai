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

const {
  CHARGE_PORT_ACTION, VALET_MODE_ACTION, WINDOW_STATE,
} = require('./const');

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

  openChargePort() {
    return this.manager.chargePortAction(this.vehicleConfig, CHARGE_PORT_ACTION.OPEN);
  }

  closeChargePort() {
    return this.manager.chargePortAction(this.vehicleConfig, CHARGE_PORT_ACTION.CLOSE);
  }

  flashLights() {
    return this.manager.startHazardLights(this.vehicleConfig);
  }

  flashLightsAndHonk() {
    return this.manager.startHazardLightsAndHorn(this.vehicleConfig);
  }

  openWindows() {
    return this.manager.setWindowsState(this.vehicleConfig, {
      frontLeft: WINDOW_STATE.OPEN,
      frontRight: WINDOW_STATE.OPEN,
      backLeft: WINDOW_STATE.OPEN,
      backRight: WINDOW_STATE.OPEN,
    });
  }

  closeWindows() {
    return this.manager.setWindowsState(this.vehicleConfig, {
      frontLeft: WINDOW_STATE.CLOSED,
      frontRight: WINDOW_STATE.CLOSED,
      backLeft: WINDOW_STATE.CLOSED,
      backRight: WINDOW_STATE.CLOSED,
    });
  }

  ventWindows() {
    return this.manager.setWindowsState(this.vehicleConfig, {
      frontLeft: WINDOW_STATE.VENTILATION,
      frontRight: WINDOW_STATE.VENTILATION,
      backLeft: WINDOW_STATE.VENTILATION,
      backRight: WINDOW_STATE.VENTILATION,
    });
  }

  setChargingCurrent(level) {
    return this.manager.setChargingCurrent(this.vehicleConfig, level);
  }

  setV2LDischargeLimit(limit) {
    return this.manager.setVehicleToLoadDischargeLimit(this.vehicleConfig, limit);
  }

  enableValetMode() {
    return this.manager.valetModeAction(this.vehicleConfig, VALET_MODE_ACTION.ACTIVATE);
  }

  disableValetMode() {
    return this.manager.valetModeAction(this.vehicleConfig, VALET_MODE_ACTION.DEACTIVATE);
  }

  drivingInfo() {
    return this.manager.drivingInfo(this.vehicleConfig);
  }
}

module.exports = Vehicle;
