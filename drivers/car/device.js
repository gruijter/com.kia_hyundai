/*
Copyright 2025, RM de Gruijter (rmdegruijter@gmail.com)

This file is part of com.hyundai

com.hyundai is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.hyundai is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.hyundai. If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const Homey = require('homey');
const GeoPoint = require('geopoint');
const util = require('util');
const { createClient, exceptions } = require('../../lib/connect');
const { buildVehicleDebugDump } = require('../../lib/connect/native/debugDump');
const geo = require('../../lib/nomatim');
const convert = require('../../lib/temp_convert');

const setTimeoutPromise = util.promisify(setTimeout);

class CarDevice extends Homey.Device {

  // this method is called when the Device is inited
  async onInit() {
    // this.log('device init: ', this.getName(), 'id:', this.getData().id);
    try {
      // migrate capabilities from old versions
      await this.migrate();
      this.initvalues(); // init some values
      this.setupQueue();
      await this.setupClient();
      this.startListeners();

      // testing stuff
      // const tripInfo = await this.vehicle.tripInfo({ year: 2025, month: 7, day: 2 });
      // const monthlyReport = await this.vehicle.monthlyReport({ year: 2025, month: 6 });
      // console.log(this.getName());
      // console.log(util.inspect(tripInfo, true, 10, true));
      // console.log(monthlyReport);

      await this.startPolling(this.settings.pollInterval);
    } catch (error) {
      this.error(error);
      this.restartDevice(10 * 60 * 1000, error.userMessage).catch((error) => this.error(error));
    }
  }

  async migrate() {
    try {
      this.log(`checking device migration for ${this.getName()}`);
      // store the capability states before migration
      const sym = Object.getOwnPropertySymbols(this).find((s) => String(s) === 'Symbol(state)');
      const state = this[sym];
      // check and repair incorrect capability(order)
      const correctCaps = this.driver.capabilitiesMap[this.getSettings().engine];
      for (let index = 0; index <= correctCaps.length; index += 1) {
        const caps = this.getCapabilities();
        const newCap = correctCaps[index];
        if (caps[index] !== newCap) {
          this.setUnavailable(this.homey.__('migrating')).catch(() => null);
          // remove all caps from here
          for (let i = index; i < caps.length; i += 1) {
            this.log(`removing capability ${caps[i]} for ${this.getName()}`);
            await this.removeCapability(caps[i])
              .catch((error) => this.log(error));
            await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
          }
          // add the new cap
          if (newCap !== undefined) {
            this.log(`adding capability ${newCap} for ${this.getName()}`);
            await this.addCapability(newCap);
            // restore capability state
            if (state[newCap]) this.log(`${this.getName()} restoring value ${newCap} to ${state[newCap]}`);
            // else this.log(`${this.getName()} has gotten a new capability ${newCap}!`);
            if (state[newCap] !== undefined) this.setCapability(newCap, state[newCap]);
            await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
          }
        }
      }
    } catch (error) {
      this.error(error);
    }
  }

  // init some values
  initvalues() {
    this.capsChanged = false;
    this.settings = this.getSettings();
    this.vehicle = null;
    this.pollMode = 0; // 0: normal, 1: engineOn with refresh
    this.isEV = this.hasCapability('ev_charging_state');
    this.lastStatus = this.getStoreValue('lastStatus');
    this.parkLocation = this.getStoreValue('parkLocation') || { latitude: 0, longitude: 0 };
    this.watchDogCounter = 6;
    this.busy = false;
    this.restarting = false;
  }

  // stuff for queue handling here
  setupQueue() {
    // queue properties
    this.queue = [];
    this.head = 0;
    this.tail = 0;
    this.queueRunning = false;
    this.enQueue = (item) => {
      if (this.disabled) {
        this.log('ignoring command; Homey live link is disabled.');
        return;
      }
      if (this.tail >= 10) {
        this.error('queue overflow');
        return;
      }
      this.queue[this.tail] = item;
      this.tail += 1;
      if (!this.queueRunning) {
        // await this.client.login(); // not needed with autoLogin: true
        this.queueRunning = true;
        this.runQueue().catch((error) => this.error(error));
      }
    };
    this.deQueue = () => {
      const size = this.tail - this.head;
      if (size <= 0) return undefined;
      const item = this.queue[this.head];
      delete this.queue[this.head];
      this.head += 1;
      // Reset the counter
      if (this.head === this.tail) {
        this.head = 0;
        this.tail = 0;
      }
      return item;
    };
    this.flushQueue = () => {
      this.queue = [];
      this.head = 0;
      this.tail = 0;
      this.queueRunning = false;
      this.log('Queue is flushed');
    };
    this.runQueue = async () => {
      try {
        this.busy = true;
        this.queueRunning = true;
        const item = this.deQueue();
        if (item) {
          if (!this.vehicle || !this.vehicle.vehicleConfig) {
            this.watchDogCounter -= 2;
            throw Error('Ignoring queued command; not logged in');
          }
          const itemWait = {
            doPoll: 5,
            start: 65,
            stop: 5,
            lock: 5,
            unlock: 5,
            setChargeTargets: 25,
            startCharge: 25,
            stopCharge: 5,
            setNavigation: 65,
          };
          this.lastCommand = item.command;
          let methodClass = this.vehicle;
          if (item.command === 'doPoll') {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            methodClass = this;
          }
          await methodClass[item.command](item.args)
            .then(() => {
              this.watchDogCounter = 6;
              this.setAvailable().catch(this.error);
            })
            .catch(async (error) => {
              const msg = error.body || error.message || error;
              // retry once on retCode: 'F', resCode: '4004', resMsg: 'Duplicate request - Duplicate request'
              let retryWorked = false;
              if (msg && (msg.includes('"resCode":"4002"') || msg.includes('"resCode":"4004"'))) {
                this.log(`${item.command} failed. Retrying in 60 seconds`);
                await setTimeoutPromise(60 * 1000, 'waiting is done');
                if (this.settings.loginOnRetry) await this.client.login();
                retryWorked = await methodClass[item.command](item.args)
                  .then(() => {
                    this.watchDogCounter = 6;
                    this.setAvailable().catch(this.error);
                    return true;
                  })
                  .catch(() => false);
              }
              if (!retryWorked) {
                this.error(`${item.command} failed`, msg);
                this.watchDogCounter -= 1;
              }
              this.busy = false;
            });
          await setTimeoutPromise((itemWait[item.command] || 5) * 1000, 'waiting is done');
          this.runQueue().catch((error) => this.error(error));
        } else {
          // console.log('Finshed queue');
          this.queueRunning = false;
          this.busy = false;
          const fixingChargerState = (this.lastCommand === 'stopCharge') || (Date.now() - this.fixChargerStateTime) < 30 * 1000;
          if (this.lastCommand !== 'doPoll' && !fixingChargerState) {
            // this.carLastActive = Date.now();
            this.enQueue({ command: 'doPoll', args: { forceOnce: true, logPoll: false } });
          }
        }
      } catch (error) {
        this.queueRunning = false;
        this.busy = false;
        this.error(error.message);
      }
    };
  }

  // setup the Kia/Hyundai connect client (lib/connect)
  async setupClient() {
    const options = {
      username: this.settings.username,
      password: this.settings.password,
      region: this.settings.region,
      language: this.settings.language || 'en', // ['cs', 'da', 'nl', 'en', 'fi', 'fr', 'de', 'it', 'pl', 'hu', 'no', 'sk', 'es', 'sv']
      pin: this.settings.pin,
      // vin: this.settings.vin,
      brand: this.homey.manifest.id.replace('com.', ''), // 'kia' or 'hyundai'
      stampMode: 'LOCAL', // 'LOCAL' or 'DISTANT'
      deviceUuid: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15), // 'homey',
      autoLogin: false,
      logger: { log: this.log.bind(this), error: this.error.bind(this) },
    };
    this.client = createClient(options);
    this.client.on('error', (error) => {
      // retCode: 'F', resCode: '5091', resMsg: 'Exceeds number of requests
      if (error.message && error.message.includes('"resCode":"5091"')) {
        this.log('Daily quotum reached! Pausing app for 60 minutes.');
        this.stopPolling();
        this.setUnavailable(this.homey.__('device_quota_reached')).catch(this.error);
        this.restartDevice(60 * 60 * 1000).catch((error) => this.error(error));
      }
      if (error.message && error.message.includes('"resCode":"4004"')) {
        this.log('Command failed (duplicate request)');
        this.watchDogCounter -= 1;
      }
      // Check the more specific OTP case before the general auth-failed case
      // (AuthenticationOTPRequired extends AuthenticationError). Both give a
      // plain-language reason instead of the generic "Device is restarting"
      // fallback — non-technical users shouldn't see raw API error text.
      if (error instanceof exceptions.AuthenticationOTPRequired) {
        const message = this.homey.__('device_otp_required');
        this.log(message);
        this.setUnavailable(message).catch(this.error);
        this.restartDevice(60 * 60 * 1000, message).catch((error) => this.error(error));
      } else if (error instanceof exceptions.AuthenticationError) {
        const message = this.homey.__('device_auth_failed');
        this.log(message);
        this.setUnavailable(message).catch(this.error);
        this.restartDevice(15 * 60 * 1000, message).catch((error) => this.error(error));
      }
      this.error(error);
      this.watchDogCounter -= 1;
      if (!this.vehicle) this.restartDevice(15 * 1000).catch((error) => this.error(error));
    });
    this.client.on('ready', (vehicles) => {
      // console.log(util.inspect(vehicles, true, 10, true));
      const [vehicle] = vehicles.filter((veh) => veh.vehicleConfig.vin === this.settings.vin);
      if (!vehicle) {
        const message = this.homey.__('device_no_vehicle', { vin: this.settings.vin });
        this.error(`${message} (${vehicles.length} vehicle(s) returned for this account)`);
        this.setUnavailable(message).catch(this.error);
        // Propagates through client.login() below, so onInit()'s catch picks
        // it up and retries every 10 minutes — recovers automatically if the
        // car gets shared again, instead of silently polling with no vehicle.
        // userMessage lets onInit()'s catch keep showing this specific reason
        // (instead of the generic "Device is restarting") during the wait.
        const error = Error(message);
        error.userMessage = message;
        throw error;
      }
      if (this.vehicle === null) this.log(JSON.stringify(vehicle.vehicleConfig));
      this.vehicle = vehicle;
    });
    await this.client.login();
    // await setTimeoutPromise(60 * 1000);
    // if (!this.client.controller || !this.client.controller.session || !this.client.controller.session.tokenExpiresAt) throw Error('client startup failed');
  }

  async startPolling(interval) {
    this.homey.clearInterval(this.intervalIdDevicePoll);
    const mode = this.pollMode ? 'car' : 'server';
    this.log(`Start polling ${mode} ${this.getName()} @ ${interval} minute interval`);
    if (this.settings.pollIntervalForced) this.log(`Warning: forced polling is enabled @${this.settings.pollIntervalForced} minute interval`);
    this.intervalIdDevicePoll = this.homey.setInterval(() => {
      if (this.watchDogCounter <= 0) {
        // restart the app here
        this.log('watchdog triggered, restarting device now');
        this.restartDevice().catch((error) => this.error(error));
        return;
      }
      if (this.busy) {
        this.watchDogCounter -= 1;
        this.log('skipping a poll');
        return;
      }
      this.enQueue({ command: 'doPoll', args: { forceOnce: false, logPoll: false } });
    }, 1000 * 60 * interval);
    // do first poll
    this.enQueue({ command: 'doPoll', args: { forceOnce: false, logPoll: true } });
    // await setTimeoutPromise(15 * 1000);
    // this.lastStatus = null; // reset lastStatus to force logging a full status poll
    // this.enQueue({ command: 'doPoll', args: true });
  }

  stopPolling() {
    this.log(`Stop polling ${this.getName()}`);
    this.homey.clearInterval(this.intervalIdDevicePoll);
  }

  async restartDevice(delay, reason) {
    if (this.restarting) return;
    this.restarting = true;
    this.stopPolling();
    this.flushQueue();
    const dly = delay || 1000 * 60 * 5;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    this.setUnavailable(reason || this.homey.__('device_restarting')).catch(this.error);
    await setTimeoutPromise(dly);
    this.onInit().catch((error) => this.error(error));
  }

  async onUninit() {
    this.log('unInit', this.getName());
    this.stopPolling();
    await setTimeoutPromise(2000).catch((error) => this.error(error)); // wait 2 secs
  }

  // this method is called when the Device is added
  async onAdded() {
    this.log(`Car added: ${this.getName()}`);
  }

  // this method is called when the Device is deleted
  onDeleted() {
    this.stopPolling();
    // this.destroyListeners();
    this.log(`Car deleted: ${this.getName()}`);
  }

  onRenamed(name) {
    this.log(`Car renamed to: ${name}`);
  }

  // this method is called when the user has changed the device's settings in Homey.
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed', this.getName(), newSettings);
    this.migrated = false;
    this.restartDevice(500).catch((error) => this.error(error));
  }

  setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined) {
      this.setCapabilityValue(capability, value).catch((error) => {
        this.error(error);
        this.error(capability, value);
      });
    }
  }

  // setSetting(setting, value) {
  //   const settings = this.getSettings();
  //   if (value !== undefined && settings && settings[setting] !== value) {
  //     const newSettings = {};
  //     newSettings[setting] = value;
  //     this.log('New setting:', newSettings);
  //     this.setSettings(newSettings).catch((error) => {
  //       this.log(error, setting, value);
  //     });
  //   }
  // }

  // poll server and/or car for status
  async doPoll({ forceOnce = false, logPoll = false }) {
    // console.log(forceOnce);
    try {
      this.setCapability('refresh_status', true);
      const batSoc = this.getCapabilityValue('measure_battery.12V');
      const forcePollInterval = this.settings.pollIntervalForced
        && (this.settings.pollIntervalForced * 60 * 1000) < (Date.now() - this.lastRefresh)
        && (Date.now() - this.lastRefresh) > 1000 * 60 * 24 * (this.settings.pollIntervalForced / 5) * ((batSoc || 50) / 100);
      // max. 24hrs forced poll @5 min & 100% charge
      const batSoCGood = this?.lastStatus?.['measure_battery.12V'] > this.settings.batteryAlarmLevel;
      const refresh = this.pollMode // 1 = engineOn with refresh
        || (batSoCGood && (forceOnce || forcePollInterval)); // || !status || !location || !odometer));

      let fullStatus;
      const ccuCCS2 = this.vehicle?.vehicleConfig?.ccuCCS2ProtocolSupport;
      const advanced = !ccuCCS2 && (typeof this.vehicle.fullStatus === 'function'); // works for EU vehicles only
      if (ccuCCS2) { // get status, location, odo meter
        fullStatus = await this.vehicle.status({
          refresh,
          parsed: false,
        });
      }
      if (advanced) { // get status, location, odo meter
        fullStatus = await this.vehicle.fullStatus({
          refresh,
          parsed: false,
        });
        // check for location data
        if (!fullStatus.vehicleLocation) {
          await setTimeoutPromise(5000);
          let location = await this.vehicle.location().catch((error) => this.error(error));
          if (!location) location = {};
          fullStatus.vehicleLocation = {
            coord: { lat: location.latitude, lon: location.longitude },
          };
        }
      }
      if (!ccuCCS2 && !advanced) { // Non-advanced ; get status separately
        const vehicleStatus = await this.vehicle.status({
          refresh,
          parsed: false,
        });
        fullStatus = {
          vehicleStatus,
          vehicleLocation: {
            coord: { lat: this.getCapabilityValue('latitude'), lon: this.getCapabilityValue('longitude') },
            speed: { value: this.getCapabilityValue('measure_speed') },
          },
          odometer: { value: this.getCapabilityValue('measure_odo') },
        };
        // check if location and odo need refresh
        if (fullStatus.time !== this?.lastStatus?.Date) { // check if server state changed
          // get location and odometer from car
          const location = await this.vehicle.location().catch((error) => this.error(error));
          fullStatus.vehicleLocation = {
            coord: { lat: location.latitude, lon: location.longitude },
          };
          const odometer = await this.vehicle.odometer().catch((error) => this.error(error));
          fullStatus.odometer = odometer;
        }
      }

      // log a redacted snapshot on the first poll after every app (re)start, so
      // it ends up in a diagnostics report after a user is asked to restart the
      // app and send one; see lib/connect/native/debugDump.js and
      // zzz_responses/db/README.md for what to do with it afterwards.
      if (logPoll) {
        const dump = buildVehicleDebugDump({
          brand: this.homey.manifest.id.replace('com.', ''),
          region: this.settings.region,
          engine: this.settings.engine,
          generation: this.settings.generation,
          ccuCCS2ProtocolSupport: this.settings.ccuCCS2ProtocolSupport,
          vehicleConfig: this.vehicle?.vehicleConfig,
          status: fullStatus,
          odometer: fullStatus?.odometer,
        });
        this.log('===VEHICLE-DEBUG-DUMP-START===');
        this.log(JSON.stringify(dump));
        this.log('===VEHICLE-DEBUG-DUMP-END===');
      }
      // console.dir(fullStatus, { depth: null, colors: true, showHidden: true });
      const stsMapped = await this.mapStatus(fullStatus);
      if (stsMapped.Date !== this?.lastStatus?.Date) {
        this.log(`${this.getName()} Server info changed. ${this?.lastStatus?.Date} ${stsMapped.Date}`);
        // console.dir(fullStatus, { depth: null });
        this.lastRefresh = Date.now();
      }

      // repair odometer status 0: fall back to the last known reading instead
      // of leaving it unset (spreading a number here produced an empty object,
      // which Homey then rejected as an invalid measure_odo capability value)
      if (!stsMapped.measure_odo) stsMapped.measure_odo = this?.lastStatus?.measure_odo;

      this.lastStatus = stsMapped;
      await this.setStoreValue('lastStatus', stsMapped).catch((error) => this.error(error));

      // check if car is active
      const justUnplugged = this.isEV && (stsMapped.ev_charging_state === 'plugged_out') && (stsMapped.ev_charging_state !== this.getCapabilityValue('ev_charging_state'));
      const justUnlocked = !stsMapped.closed_locked && (stsMapped.closed_locked !== this.getCapabilityValue('closed_locked'));
      const climateOn = stsMapped.climate_control || stsMapped.defrost;
      const engineOn = stsMapped.engine;
      const carActive = engineOn || climateOn || justUnplugged || justUnlocked;
      // console.log(`${this.getName()} unplggd: ${justUnplugged}, unlckd: ${justUnlocked}, a/c: ${climateOn}, engine: ${engineOn}`);
      if (carActive) this.carLastActive = Date.now();
      const carJustActive = ((Date.now() - this.carLastActive) < 3 * 60 * 1000); // human activity or refresh triggered recently

      // update capabilities and flows
      await this.handleInfo(stsMapped).catch((error) => this.error(error));
      this.setCapability('refresh_status', false);

      // fix charger state after refresh
      // if (this.settings.chargeStateFix && this.isEV && refresh
      //   && status && status.evStatus && status.evStatus.batteryPlugin && !status.evStatus.batteryCharge) {
      //   await setTimeoutPromise(15 * 1000); // wait a bit for Homey to settle
      //   await this.chargingOnOff(false, 'charger off state fix');
      //   this.fixChargerStateTime = Date.now();
      // }

      // variable polling interval based on active state
      if (this.settings.pollIntervalEngineOn && !this.pollMode && carJustActive) {
        this.pollMode = 1; // engineOn poll mode
        this.startPolling(this.settings.pollIntervalEngineOn).catch((error) => this.error(error));
      } else if (this.pollMode && !carJustActive) {
        this.pollMode = 0; // normal poll mode
        this.startPolling(this.settings.pollInterval).catch((error) => this.error(error));
      }

      return Promise.resolve(true);
    } catch (error) {
      this.error(error);
      this.setCapability('refresh_status', false);
      return Promise.reject(error);
    }
  }

  async handleInfo(info) {
    try {

      const moving = this.isMoving(info);
      const hasParked = this.isParking(info);

      // update capabilities
      for (const [cap, val] of Object.entries(info)) {
        this.setCapability(cap, val);
      }
      if (this.lastRefresh) {
        const ds = new Date(this.lastRefresh);
        const date = ds.toString().substring(4, 11);
        const time = ds.toLocaleTimeString('nl-NL', { hour12: false, timeZone: this.homey.clock.getTimezone() }).substring(0, 5);
        this.setCapability('last_refresh', `${date} ${time}`);
      }

      // update flow triggers
      const tokens = {};
      if (moving) {
        this.homey.flow.getDeviceTriggerCard('has_moved')
          .trigger(this, tokens)
          .catch(this.error);
      }

      if (hasParked) {
        this.parkLocation = { ...info };
        this.setStoreValue('parkLocation', this.parkLocation).catch((error) => this.error(error));
        this.log(`new park location: ${info.location}`);
        // this.carLastActive = Date.now(); // keep polling for some time
        tokens.address = info.address;
        tokens.map = `https://www.google.com/maps?q=${info.latitude},${info.longitude}`;
        // console.log(this.getName(), tokens);
        this.homey.flow.getDeviceTriggerCard('has_parked')
          .trigger(this, tokens)
          .catch(this.error);
      }

      if ((Date.now() - this.lastRefresh) < 30 * 1000) {
        this.homey.flow.getDeviceTriggerCard('status_update')
          .trigger(this, {})
          .catch(this.error);
      }
    } catch (error) {
      this.error(error);
    }
  }

  // helper functions
  async mapStatus(status) {
    const map = {};
    if (!status) return Promise.resolve(map);
    let sts = { ...status }; // clone status
    // is old type full status
    if (sts.vehicleStatus) {
      map.measure_odo = sts?.odometer?.value;
      map.latitude = sts?.vehicleLocation?.coord?.lat;
      map.longitude = sts?.vehicleLocation?.coord?.lon;
      const speed = sts?.vehicleLocation?.speed?.value;
      map.measure_speed = speed > 255 ? 0 : speed;
      map.meter_distance = Math.round(this.distance(map) * 10) / 10;
      const carLocString = await geo.getCarLocString(map).catch((error) => this.error(error)); // ReverseGeocoding
      map.location = carLocString?.local;
      map.address = carLocString?.address;
      sts = { ...status.vehicleStatus };
    }
    // is old type simple or full status
    if (sts.time) {
      // determine chargeState
      const charge = sts?.evStatus?.batteryCharge;
      let charger = sts?.evStatus?.batteryPlugin; // 0=none 1=fast 2=slow/normal
      if (charger && !charge) charger += 2; // 3= fast off, 4 = slow off
      let evChargingState;
      if (charger === 1 || charger === 2) {
        evChargingState = 'plugged_in_charging';
      } else if (charger === 3 || charger === 4) {
        evChargingState = 'plugged_in';
      } else {
        evChargingState = 'plugged_out';
      }
      map.climate_control = sts.airCtrlOn;
      map.target_temperature = sts.airCtrlOn ? convert.getTempFromCode(sts.airTemp.value) : this.getCapabilityValue('target_temperature');
      map.locked = sts.doorLock;
      map.defrost = sts.defrost;
      map.engine = sts.engine;
      map.closed_locked = sts.doorLock && !sts.trunkOpen && !sts.hoodOpen && Object.keys(sts.doorOpen).reduce((closedAccu, door) => closedAccu || !sts.doorOpen[door], true);
      map['alarm_tire_pressure'] = !!sts?.tirePressureLamp?.tirePressureLampAll;
      map['measure_battery.12V'] = sts?.battery?.batSoc;
      map.measure_range = sts?.evStatus?.drvDistance?.[0]?.rangeByFuel?.totalAvailableRange?.value || sts?.dte?.value;
      if (map.measure_range === undefined || map.measure_range < 0) map.measure_range = null; // Sorento weird server response
      map.measure_battery = sts?.evStatus?.batteryStatus;
      map['measure_power.charge'] = null;
      map['meter_power.fuel_economy'] = null;
      map.charge = charge;
      const targetSOClist = sts?.evStatus?.reservChargeInfos?.targetSOClist;
      if (targetSOClist) {
        map.charge_target_slow = targetSOClist.find((list) => list.plugType === 1)?.targetSOClevel.toString();
        map.charge_target_fast = targetSOClist.find((list) => list.plugType === 0)?.targetSOClevel.toString();
      }
      map.ev_charging_state = evChargingState;
      map['alarm_bat'] = (sts?.battery?.batSoc < this.settings.batteryAlarmLevel) || (sts?.evStatus?.batteryStatus < this.settings.EVbatteryAlarmLevel);
      map.Date = sts.time;
    }
    // is new type status
    if (sts.Date) {
      map.measure_odo = sts?.Drivetrain?.Odometer;
      map.latitude = sts?.Location?.GeoCoord?.Latitude;
      map.longitude = sts?.Location?.GeoCoord?.Longitude;
      const speed = sts?.Location?.Speed?.Value;
      map.measure_speed = speed > 255 ? 0 : speed;
      map.meter_distance = Math.round(this.distance(map) * 10) / 10;
      const carLocString = await geo.getCarLocString(map).catch((error) => this.error(error)); // ReverseGeocoding
      map.location = carLocString?.local;
      map.address = carLocString?.address;

      // determine chargeState
      map['measure_power.charge'] = sts?.Green?.Electric?.SmartGrid?.RealTimePower * 1000;
      map['meter_power.fuel_economy'] = sts?.Drivetrain?.FuelSystem?.AverageFuelEconomy?.Drive;
      const charge = !!sts?.Green?.ChargingInformation?.Charging?.RemainTime;
      let charger = sts?.Green?.ChargingInformation?.ConnectorFastening?.State; // 0=none 1=fast 2=slow/normal
      if (charger && !charge) charger += 2; // 3= fast off, 4 = slow off
      let evChargingState;
      if (charger === 1 || charger === 2) {
        evChargingState = 'plugged_in_charging';
      } else if (charger === 3 || charger === 4) {
        evChargingState = 'plugged_in';
      } else {
        evChargingState = 'plugged_out';
      }
      let targetTemp = sts?.Cabin?.HVAC?.Row1?.Driver?.Temperature?.Value;
      if (typeof targetTemp === 'string' && !Number.isNaN(Number(targetTemp))) {
        targetTemp = Number(targetTemp);
      }
      map.climate_control = !(targetTemp === 'OFF');
      map.target_temperature = targetTemp === 'OFF' ? this.getCapabilityValue('target_temperature') : targetTemp;
      map.defrost = !!sts?.Body?.Windshield?.Front?.Defog?.State || !!sts?.Body?.Windshield?.Rear?.Defog?.State;

      // Check doors
      const doors = [
        sts?.Cabin?.Door?.Row1?.Driver,
        sts?.Cabin?.Door?.Row1?.Passenger,
        sts?.Cabin?.Door?.Row2?.Left,
        sts?.Cabin?.Door?.Row2?.Right,
      ].filter(Boolean);
      const allDoorsClosed = doors.every((d) => d.Open === 0);
      const allDoorsLocked = doors.every((d) => d.Lock === 0);
      // Check windows
      const windows = [
        sts?.Cabin?.Window?.Row1?.Driver,
        sts?.Cabin?.Window?.Row1?.Passenger,
        sts?.Cabin?.Window?.Row2?.Left,
        sts?.Cabin?.Window?.Row2?.Right,
      ].filter(Boolean);
      const allWindowsClosed = windows.every((w) => w.Open === 0);
      // Check trunk, hood, sunroof — treat an absent field (car has no sunroof,
      // or the field isn't reported) as closed rather than as open, otherwise
      // closed_locked incorrectly stays false forever on cars without one.
      const trunkClosed = [undefined, 0].includes(sts?.Body?.Trunk?.Open);
      const hoodClosed = [undefined, 0].includes(sts?.Body?.Hood?.Open);
      const sunroofClosed = [undefined, 0].includes(sts?.Body?.Sunroof?.Glass?.Open);
      map.locked = allDoorsLocked;
      map.closed_locked = allDoorsClosed && allDoorsLocked && allWindowsClosed && trunkClosed && hoodClosed && sunroofClosed;
      map.engine = !!sts.DrivingReady;
      map['alarm_tire_pressure'] = !!sts?.battery?.Axle?.Tire?.PressureLow;
      map['measure_battery.12V'] = sts?.Electronics?.Battery?.Level;
      map.measure_range = sts?.Drivetrain?.FuelSystem?.DTE.Total;
      map.measure_battery = sts?.Green?.BatteryManagement?.BatteryRemain.Ratio;
      map.charge = charge;
      map.charge_target_slow = sts?.Green?.ChargingInformation?.TargetSoC?.Standard.toString();
      map.charge_target_fast = sts?.Green?.ChargingInformation?.TargetSoC?.Quick.toString();
      map.ev_charging_state = evChargingState;
      map['alarm_bat'] = (map['measure_battery.12V'] < this.settings.batteryAlarmLevel) || (map.measure_battery < this.settings.EVbatteryAlarmLevel);
      map.Date = sts.Date;
    }
    return Promise.resolve(map);
  }

  isMoving(info) {
    const previousLocation = { latitude: this.getCapabilityValue('latitude'), longitude: this.getCapabilityValue('longitude') };
    if (!info.measure_speed || !previousLocation.latitude) return false;
    const moving = info.measure_speed > 0
      || (Math.abs(info.latitude - previousLocation.latitude) > 0.0001
        || Math.abs(info.longitude - previousLocation.longitude) > 0.0001);
    // console.log(`${this.getName()} is moving: ${moving}@${info.measure_speed} km/h`);
    return moving;
  }

  isParking(info) {
    const parked = !info.engine; //  && (Date.now() - this.lastMoved > 30 * 1000); // 30s after engine shut off or sleepModeCheck
    if (!parked) return false; // car is driving
    const newLocation = Math.abs(info.latitude - this.parkLocation.latitude) > 0.0003
      || Math.abs(info.longitude - this.parkLocation.longitude) > 0.0003;
    const parking = parked && newLocation;
    // if (parking) console.log(`${this.getName()} is parking`);
    return parking;
  }

  distance(location) {
    const lat1 = location.latitude;
    const lon1 = location.longitude;
    const lat2 = this.settings.lat;
    const lon2 = this.settings.lon;
    const from = new GeoPoint(Number(lat1), Number(lon1));
    const to = new GeoPoint(Number(lat2), Number(lon2));
    return Math.round(from.distanceTo(to, true) * 100) / 100;
  }

  acOnOff(acOn, source) {
    try {
      if (this.getCapabilityValue('engine')) throw Error(this.homey.__('error_engine_on'));
      let command;
      let args;
      if (acOn) {
        this.log(`A/C on via ${source}`); // app or flow
        command = 'start';
        args = {
          // igniOnDuration: 10,
          temperature: this.getCapabilityValue('target_temperature') || 22,
        };
      } else {
        this.log(`A/C off via ${source}`); // app or flow
        command = 'stop';
        args = {
          // temperature: this.getCapabilityValue('target_temperature') || 22,
        };
        this.setCapability('defrost', false); // set defrost state to off
      }
      this.enQueue({ command, args });
      return true;
    } catch (error) {
      return error;
    }
  }

  defrostOnOff(defrost, source) {
    try {
      if (this.getCapabilityValue('engine')) throw Error(this.homey.__('error_engine_on'));
      let command;
      let args;
      if (defrost) {
        this.log(`defrost on via ${source}`);
        command = 'start';
        args = {
          // igniOnDuration: 10, // doesn't seem to do anything
          defrost: true,
          windscreenHeating: true,
          heatedFeatures: true, // for bluelinky >v8
          // unknown if this does anything
          heating1: 1,
          steerWheelHeat: 1,
          sideBackWindowHeat: 1,
          temperature: this.getCapabilityValue('target_temperature') || 22,
        };
      } else {
        this.log(`defrost off via ${source}`);
        command = 'stop';
        args = {
          defrost: false,
          windscreenHeating: false,
          heatedFeatures: false, // for bluelinky >v8
          // unknown if this does anything
          heating1: 0,
          steerWheelHeat: 0,
          sideBackWindowHeat: 0,
        };
        this.enQueue({ command, args }); // have to do it twice to get defrost reported as off
        this.setCapability('climate_control', false); // set AC state to off
      }
      this.enQueue({ command, args });
      return true;
    } catch (error) {
      return error;
    }
  }

  chargingOnOff(charge, source) {
    try {
      if (!this.isEV) throw Error(this.homey.__('error_not_ev'));
      let command;
      if (charge) {
        this.log(`charging on via ${source}`);
        command = 'startCharge';
      } else {
        this.log(`charging off via ${source}`);
        command = 'stopCharge';
      }
      this.enQueue({ command });
      return true;
    } catch (error) {
      return error;
    }
  }

  lock(locked, source) {
    try {
      let command;
      if (locked) {
        this.log(`locking doors via ${source}`);
        command = 'lock';
      } else {
        this.log(`unlocking doors via ${source}`);
        command = 'unlock';
      }
      this.enQueue({ command });
      return true;
    } catch (error) {
      return error;
    }
  }

  setTargetTemp(temp, source) {
    try {
      if (this.getCapabilityValue('engine')) throw Error(this.homey.__('error_engine_on'));
      if (!this.getCapabilityValue('climate_control')) throw Error(this.homey.__('error_climate_control_off'));
      this.log(`Temperature set by ${source} to ${temp}`);
      const args = {
        temperature: temp || 22,
      };
      const command = 'start';
      this.enQueue({ command, args });
      return true;
    } catch (error) {
      return error;
    }
  }

  setChargeTargets(targets = { fast: 100, slow: 80 }, source) {
    try {
      if (!this.isEV) throw Error(this.homey.__('error_not_ev'));
      this.log(`Charge target is set by ${source} to slow:${targets.slow} fast:${targets.fast}`);
      const args = { fast: Number(targets.fast), slow: Number(targets.slow) };
      const command = 'setChargeTargets';
      this.enQueue({ command, args });
      return true;
    } catch (error) {
      return error;
    }
  }

  async setDestination(destination, source) { // free text, latitude/longitude object or nomatim search object
    this.log(`Destination set by ${source} to ${JSON.stringify(destination)}`);
    let searchParam = destination;
    // check if destination is location object format
    if (destination && destination.latitude && destination.longitude) {
      searchParam = `${destination.latitude},${destination.longitude}`;
    }
    const dest = await geo.search(searchParam).catch((error) => this.error(error.messsage || error));
    if (!dest) throw Error(this.homey.__('error_location_not_found'));
    const args = [
      {
        phone: dest.extratags.phone || '',
        waypointID: 0,
        lang: 1,
        src: 'HOMEY',
        coord: {
          lat: Number(dest.lat), lon: Number(dest.lon), type: 0,
        },
        addr: dest.display_name,
        zip: dest.address.postcode || '',
        placeid: dest.display_name,
        name: dest.namedetails.name || dest.display_name,
      },
    ];
    const command = 'setNavigation';
    this.enQueue({ command, args });
    return Promise.resolve(true);
  }

  refreshStatus(refresh, source) {
    try {
      if (refresh) {
        this.setCapability('refresh_status', true);
        this.log(`Forcing status refresh via ${source}`);
        if (source === 'app' || source === 'cloud') this.carLastActive = Date.now();
        this.enQueue({ command: 'doPoll', args: { forceOnce: true, logPoll: false } });
      }
      return true;
    } catch (error) {
      return error;
    }
  }

  // register capability listeners
  startListeners() {
    if (!this.listenersSet) {
      this.log(`${this.getName()} starting capability listeners`);
      // capabilityListeners will be overwritten, so no need to unregister them
      this.registerCapabilityListener('locked', (locked) => this.lock(locked, 'app'));
      this.registerCapabilityListener('defrost', (defrost) => this.defrostOnOff(defrost, 'app'));
      this.registerCapabilityListener('climate_control', (acOn) => this.acOnOff(acOn, 'app'));
      this.registerCapabilityListener('target_temperature', async (temp) => this.setTargetTemp(temp, 'app'));
      this.registerCapabilityListener('refresh_status', (refresh) => this.refreshStatus(refresh, 'app'));
      this.registerCapabilityListener('charge', (charge) => this.chargingOnOff(charge, 'app'));
      this.registerMultipleCapabilityListener(['charge_target_slow', 'charge_target_fast'], async (values) => {
        const slow = Number(values.charge_target_slow) || Number(this.getCapabilityValue('charge_target_slow'));
        const fast = Number(values.charge_target_fast) || Number(this.getCapabilityValue('charge_target_fast'));
        const targets = { slow, fast };
        this.setChargeTargets(targets, 'app');
      }, 10000);
      this.listenersSet = true;
    }
  }

}

module.exports = CarDevice;
