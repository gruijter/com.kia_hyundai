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

const Homey = require('homey');

module.exports = class MyApp extends Homey.App {

  async onInit() {
    this.registerFlowListeners();
    this.log('App has been initialized');
  }

  registerFlowListeners() {
    // action cards
    const forcePoll = this.homey.flow.getActionCard('force_refresh');
    forcePoll.registerRunListener((args) => args.device.refreshStatus(true, 'flow'));

    const chargingOff = this.homey.flow.getActionCard('charge_off');
    chargingOff.registerRunListener((args) => args.device.chargingOnOff(false, 'flow'));

    const chargingOn = this.homey.flow.getActionCard('charge_on');
    chargingOn.registerRunListener((args) => args.device.chargingOnOff(true, 'flow'));

    const acOff = this.homey.flow.getActionCard('ac_off');
    acOff.registerRunListener((args) => args.device.acOnOff(false, 'flow'));

    const acOn = this.homey.flow.getActionCard('ac_on');
    acOn.registerRunListener((args) => args.device.acOnOff(true, 'flow', args));

    const defrostOff = this.homey.flow.getActionCard('defrost_off');
    defrostOff.registerRunListener((args) => args.device.defrostOnOff(false, 'flow'));

    const defrostOn = this.homey.flow.getActionCard('defrost_on');
    defrostOn.registerRunListener((args) => args.device.defrostOnOff(true, 'flow', args));

    const setTargetTemp = this.homey.flow.getActionCard('set_target_temp');
    setTargetTemp.registerRunListener((args) => args.device.setTargetTemp(args.temp, 'flow'));

    const setChargeTargets = this.homey.flow.getActionCard('set_charge_targets');
    setChargeTargets.registerRunListener((args) => args.device.setChargeTargets(args, 'flow'));

    const setDestination = this.homey.flow.getActionCard('set_destination');
    setDestination.registerRunListener((args) => args.device.setDestination(args.destination, 'flow'));

    const flashLights = this.homey.flow.getActionCard('flash_lights');
    flashLights.registerRunListener((args) => args.device.flashLights(false, 'flow'));

    const flashLightsAndHonk = this.homey.flow.getActionCard('flash_lights_and_honk');
    flashLightsAndHonk.registerRunListener((args) => args.device.flashLights(true, 'flow'));

    const chargePortOpen = this.homey.flow.getActionCard('charge_port_open');
    chargePortOpen.registerRunListener((args) => args.device.chargePortOpen(true, 'flow'));

    const chargePortClose = this.homey.flow.getActionCard('charge_port_close');
    chargePortClose.registerRunListener((args) => args.device.chargePortOpen(false, 'flow'));

    const windowsOpen = this.homey.flow.getActionCard('windows_open');
    windowsOpen.registerRunListener((args) => args.device.setWindows('open', 'flow'));

    const windowsClose = this.homey.flow.getActionCard('windows_close');
    windowsClose.registerRunListener((args) => args.device.setWindows('closed', 'flow'));

    const windowsVent = this.homey.flow.getActionCard('windows_vent');
    windowsVent.registerRunListener((args) => args.device.setWindows('vent', 'flow'));

    const setChargingCurrent = this.homey.flow.getActionCard('set_charging_current');
    setChargingCurrent.registerRunListener((args) => args.device.setChargingCurrent(args.level, 'flow'));

    const setV2LDischargeLimit = this.homey.flow.getActionCard('set_v2l_discharge_limit');
    setV2LDischargeLimit.registerRunListener((args) => args.device.setV2LDischargeLimit(args.limit, 'flow'));

    const valetModeOn = this.homey.flow.getActionCard('valet_mode_on');
    valetModeOn.registerRunListener((args) => args.device.setValetMode(true, 'flow'));

    const valetModeOff = this.homey.flow.getActionCard('valet_mode_off');
    valetModeOff.registerRunListener((args) => args.device.setValetMode(false, 'flow'));

    // condition cards
    const alarmBattery = this.homey.flow.getConditionCard('alarm_bat');
    alarmBattery.registerRunListener((args) => args.device.getCapabilityValue('alarm_bat'));

    const alarmTirePressure = this.homey.flow.getConditionCard('alarm_tire_pressure');
    alarmTirePressure.registerRunListener((args) => args.device.getCapabilityValue('alarm_tire_pressure'));

    const charging = this.homey.flow.getConditionCard('charge');
    charging.registerRunListener((args) => args.device.getCapabilityValue('charge'));

    const climateControl = this.homey.flow.getConditionCard('climate_control');
    climateControl.registerRunListener((args) => args.device.getCapabilityValue('climate_control'));

    const closedLocked = this.homey.flow.getConditionCard('closed_locked');
    closedLocked.registerRunListener((args) => args.device.getCapabilityValue('closed_locked'));

    const defrost = this.homey.flow.getConditionCard('defrost');
    defrost.registerRunListener((args) => args.device.getCapabilityValue('defrost'));

    const engine = this.homey.flow.getConditionCard('engine');
    engine.registerRunListener((args) => args.device.getCapabilityValue('engine'));

    const moving = this.homey.flow.getConditionCard('moving');
    moving.registerRunListener((args) => args.device.moving);

    const parked = this.homey.flow.getConditionCard('parked');
    parked.registerRunListener((args) => !args.device.getCapabilityValue('engine'));

  }

};
