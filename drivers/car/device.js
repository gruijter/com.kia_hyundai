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
const util = require('util');
const { createClient, exceptions, constants } = require('../../lib/connect');
const { buildVehicleDebugDump } = require('../../lib/connect/native/debugDump');
const {
  ccs2ReservationTimeOrNone, legacyReservationTimeOrNone, ccs2DepartureDays, nextDepartureOccurrence,
} = require('../../lib/connect/native/utils');
const geo = require('../../lib/nomatim');
const convert = require('../../lib/temp_convert');
const { distanceKm } = require('../../lib/geo_distance');
const { isImperialUnit, kmToMi, miToKm } = require('../../lib/distance_convert');
const DeviceMigrator = require('../../lib/DeviceMigrator');

const {
  CHARGE_PORT_ACTION, VALET_MODE_ACTION, WINDOW_STATE, SEAT_STATUS, HEAT_STATUS,
} = constants;

const setTimeoutPromise = util.promisify(setTimeout);

// All four windows to the same state — matches the "all windows" flow
// actions (open/close/vent); see device.js#runCommand.
const allWindows = (state) => ({
  frontLeft: state, frontRight: state, backLeft: state, backRight: state,
});

// Seconds to wait after a command before the queue picks up the next item —
// the car's cloud API rejects requests sent too close together.
const ITEM_WAIT_SECONDS = {
  doPoll: 5,
  start: 65,
  stop: 5,
  lock: 5,
  unlock: 5,
  setChargeTargets: 25,
  startCharge: 25,
  stopCharge: 5,
  setNavigation: 65,
  flashLights: 5,
  flashLightsAndHonk: 5,
  openChargePort: 15,
  closeChargePort: 15,
  openWindows: 15,
  closeWindows: 15,
  ventWindows: 15,
  setChargingCurrent: 5,
  setV2LDischargeLimit: 5,
  enableValetMode: 5,
  disableValetMode: 5,
};

// enQueue()'s returned promise races the item's real result against this
// timeout, falling back to an optimistic `true` if it fires first — Homey's
// capability-listener/flow-action-listener GUI times out after ~10s, but
// most commands stay queued (behind other items, or a 60s duplicate-request
// retry backoff) far longer than that. Better to occasionally under-report
// a slow failure than to routinely show a false "failed" for a command
// that's still legitimately in progress.
const ENQUEUE_RESULT_TIMEOUT_MS = 8 * 1000;

// Ceiling for setupClient()'s login retry backoff (15s, 30s, 60s ... capped).
// 15 minutes matches the AuthenticationError branch's own fixed retry, and
// keeps a device that's down for a whole day at ~100 login attempts instead
// of ~5700.
const LOGIN_BACKOFF_MAX_MS = 15 * 60 * 1000;

class CarDevice extends Homey.Device {

  // this method is called when the Device is inited
  async onInit() {
    // this.log('device init: ', this.getName(), 'id:', this.getData().id);
    if (this.destroyed) return;
    try {
      // migrate capabilities from old versions
      await this.migrate();
      this.initvalues(); // init some values
      this.setupQueue();
      await this.setupClient();
      this.startListeners();
      await this.startPolling(this.settings.pollInterval);
    } catch (error) {
      this.error(error);
      this.restartDevice(10 * 60 * 1000, error.userMessage).catch((error) => this.error(error));
    }
  }

  async migrate() {
    try {
      // Drop capabilities the car has never actually reported data for (see
      // driver.js#capabilitiesToCheck) — sourced from the device's own stored
      // status rather than a live fetch, so migration doesn't add an extra
      // vehicle-API call on every app restart. This reliably catches the
      // confirmed legacy/non-CCS2 gap (see the comment above
      // `alarm_generic.washer_fluid` in mapStatus() below); it can't catch a
      // hypothetical CCS2-side version of the same gap, since those fields
      // are coerced to a boolean before being stored.
      //
      // "Never reported" is what's meant, so a capability the car HAS
      // reported at some point overrides whatever the most recent status
      // says: one truncated response (a status missing its whole `evStatus`/
      // `Green` branch, say) would otherwise permanently drop the capability
      // at the next restart, and removeCapability() breaks every flow using
      // it — three of the checked capabilities have condition cards.
      // recordSeenCaps() collects that evidence on each poll; an empty/absent
      // `seenCaps` (device from before this existed) simply falls back to the
      // last-status-only behaviour.
      // Both absent (freshly paired, or a cleared store) must stay `null`:
      // filterSupportedCapabilities() treats a falsy status as "no evidence
      // either way" and prunes nothing, where an empty object would read as
      // "reports none of them" and strip the capabilities pairing just
      // correctly added.
      const lastStatus = this.getStoreValue('lastStatus');
      const seenCaps = this.getStoreValue('seenCaps');
      const evidence = (lastStatus || seenCaps) ? { ...lastStatus, ...seenCaps } : null;
      const correctCaps = this.driver.filterSupportedCapabilities(
        this.driver.capabilitiesMap[this.getSettings().engine],
        evidence,
      );
      await DeviceMigrator.migrateCapabilities(this, correctCaps);
    } catch (error) {
      this.error(error);
    }
    // Its own try/catch rather than chained onto the migration above: the two
    // are independent, and a device whose `engine` setting is missing or
    // unrecognised — exactly the population driver.js#onRepair() exists for —
    // makes capabilitiesMap[engine] undefined and throws inside
    // migrateCapabilities(), which used to take the unit-marker repair
    // (community report #1050) down with it. Still runs after it, since a
    // capability migration is one of the things that resets unit options.
    try {
      await DeviceMigrator.reconcileUnitMarkers(this);
    } catch (error) {
      this.error(error);
    }
  }

  // Remembers which of driver.js#capabilitiesToCheck this car has ever
  // reported a real value for, so migrate() can prune on "never seen" rather
  // than "missing from the most recent status". Write-once per capability:
  // after the first poll that reports them all, this never touches the store
  // again.
  async recordSeenCaps(stsMapped) {
    const seen = this.getStoreValue('seenCaps') || {};
    let changed = false;
    this.driver.capabilitiesToCheck.forEach((cap) => {
      // Only for capabilities this device actually has. mapStatus()'s CCS2
      // branch coerces the three `alarm_generic.*` fields with `!!`, so a
      // field the car never reports arrives here as `false` — a real value as
      // far as isUnsupportedValue() is concerned. Without this guard a
      // capability that pairing correctly pruned (extractCheckableStatus()
      // reads those fields raw, so it saw `undefined`) got evidence recorded
      // on the first poll and was re-added by migrate() at the next restart,
      // permanently: seenCaps has no expiry.
      if (!this.hasCapability(cap)) return;
      if (seen[cap] || this.driver.isUnsupportedValue(stsMapped[cap])) return;
      seen[cap] = true;
      changed = true;
    });
    if (changed) await this.setStoreValue('seenCaps', seen);
  }

  // init some values
  initvalues() {
    this.settings = this.getSettings();
    this.vehicleConfig = null;
    this.pollMode = 0; // 0: normal, 1: engineOn with refresh
    this.isEV = this.hasCapability('ev_charging_state');
    this.lastStatus = this.getStoreValue('lastStatus');
    this.parkLocation = this.getStoreValue('parkLocation') || { latitude: 0, longitude: 0 };
    this.watchDogCounter = 6;
    this.busy = false;
    this.restarting = false;
    this.restartTimeout = null;
    this.moving = false; // read by the 'moving' flow condition card (app.js)
    // for [queue-timing] logging only, see runQueue() — real-world data on
    // whether ITEM_WAIT_SECONDS is actually long enough per command, since
    // those values (especially for commands added in 2026) are an unverified
    // guess, not something tested against the live API or documented anywhere.
    this.lastCommandDispatched = null;
    this.lastCommandDispatchedAt = null;
  }

  // Defined on the class rather than assigned inside setupQueue() below: a
  // device spends its whole first onInit() inside `await this.migrate()`,
  // which runs for minutes whenever a release reorders capabilities (2s
  // settle per add and per remove), and both markDestroyed() and
  // restartDevice() can fire in that window — before setupQueue() has run.
  // As an instance property this threw `this.flushQueue is not a function`
  // there, aborting teardown, and in restartDevice() it left `restarting`
  // true with no timer ever scheduled, stalling that device for good.
  flushQueue() {
    this.queue = [];
    this.queueRunning = false;
    this.log('Queue is flushed');
  }

  // stuff for queue handling here
  setupQueue() {
    this.queue = [];
    this.queueRunning = false;
    // Bumped on every setup so a runQueue() loop left over from before a
    // restart can tell it is stale. restartDevice() flushes the queue and
    // re-enters onInit(), but a loop parked in the ITEM_WAIT_SECONDS sleep
    // (up to 65s) survives that: it resumes, resolves `this.deQueue` to the
    // NEW closure over the NEW array, and drains it alongside the fresh
    // loop — defeating the command spacing and producing exactly the
    // duplicate/rate-limit rejections the [queue-timing] logging exists to
    // diagnose. Worse, on finding the new queue momentarily empty it would
    // fall out of its `while` and clear `queueRunning` for the loop that is
    // legitimately running, so the next enQueue() started a third drain.
    this.queueGeneration = (this.queueGeneration || 0) + 1;
    const generation = this.queueGeneration;
    // Returns a promise for this specific item's result. It races the
    // item's real outcome against ENQUEUE_RESULT_TIMEOUT_MS — see that
    // constant's comment for why. Fire-and-forget callers (internal
    // auto-polls) should attach a no-op .catch() since a fast, definitive
    // failure (e.g. a full queue) does reject this promise.
    this.enQueue = (item) => {
      if (this.destroyed) return Promise.reject(Error('device is gone'));
      if (this.queue.length >= 10) {
        this.error('queue overflow');
        return Promise.reject(Error(this.homey.__('error_queue_full')));
      }
      const result = new Promise((resolve, reject) => {
        item.resolve = resolve;
        item.reject = reject;
      });
      result.catch(() => {}); // avoid an unhandled-rejection warning if the race below resolves via the timeout first
      this.queue.push(item);
      if (!this.queueRunning) {
        this.runQueue().catch((error) => this.error(error));
      }
      return Promise.race([
        result,
        setTimeoutPromise(ENQUEUE_RESULT_TIMEOUT_MS).then(() => true),
      ]);
    };
    this.deQueue = () => this.queue.shift();
    this.runQueue = async () => {
      if (this.queueRunning) return; // already draining, e.g. called again from enQueue while busy
      this.queueRunning = true;
      this.busy = true;
      let needsFollowUpPoll = false;
      try {
        let item = this.deQueue();
        while (item) {
          if (this.destroyed || this.queueGeneration !== generation) return;
          if (!this.vehicleConfig) {
            this.watchDogCounter -= 2;
            throw Error('Ignoring queued command; not logged in');
          }
          this.lastCommand = item.command;
          const dispatch = () => (item.command === 'doPoll'
            ? this.doPoll(item.args)
            : this.runCommand(item.command, item.args));
          // [queue-timing] real-world data point for whether
          // ITEM_WAIT_SECONDS is actually long enough — see initvalues().
          // Only logged for non-doPoll (control) commands; doPoll's own
          // spacing isn't in question here. previousCommand/sinceLastMs are
          // captured into locals before being overwritten below, so the
          // .catch() handler further down still refers to the *previous*
          // command, not the one that just got rejected.
          const previousCommand = this.lastCommandDispatched;
          const sinceLastMs = this.lastCommandDispatchedAt ? Date.now() - this.lastCommandDispatchedAt : null;
          if (item.command !== 'doPoll') {
            this.log(`[queue-timing] ${item.command} dispatched ${sinceLastMs}ms after previous command `
              + `(${previousCommand || 'none'}, configured wait ${ITEM_WAIT_SECONDS[previousCommand] ?? 'n/a'}s)`);
          }
          this.lastCommandDispatched = item.command;
          this.lastCommandDispatchedAt = Date.now();
          // eslint-disable-next-line no-await-in-loop
          await dispatch()
            .then(() => {
              this.watchDogCounter = 6;
              if (!this.destroyed) this.setAvailable().catch(this.error);
              item.resolve(true);
            })
            .catch(async (error) => {
              const msg = error.body || error.message || error;
              // Retry once on a stale-device-id or duplicate-request rejection.
              // These arrive as typed exceptions (DeviceIDError/DuplicateRequestError,
              // see lib/connect/native/ApiImplType1.js#checkResponseForErrors), whose
              // .message is just the bare resMsg text (e.g. 'Duplicate request -
              // Duplicate request') — not a raw JSON blob — so check the type, not a
              // '"resCode":"4004"' substring that never actually appears in it.
              let retryWorked = false;
              if (error instanceof exceptions.DeviceIDError || error instanceof exceptions.DuplicateRequestError) {
                // [queue-timing] this is the actually interesting case: a
                // real rate-limit/duplicate rejection, with exactly how much
                // time had elapsed since the previous command.
                this.log(`[queue-timing] ${item.command} REJECTED as duplicate/rate-limited ${sinceLastMs}ms after `
                  + `previous command (${previousCommand || 'none'}). Retrying in 60 seconds`);
                await setTimeoutPromise(60 * 1000, 'waiting is done');
                if (this.destroyed) return;
                if (this.settings.loginOnRetry) {
                  const vehicleConfigs = await this.client.login();
                  const vehicleConfig = vehicleConfigs.find((vc) => vc.vin === this.settings.vin);
                  if (vehicleConfig) this.vehicleConfig = vehicleConfig;
                }
                // login() above is a network round-trip; without re-checking
                // here a device deleted (or an app unloaded) during it would
                // still have dispatch() send a real command to the car.
                if (this.destroyed || this.queueGeneration !== generation) return;
                retryWorked = await dispatch()
                  .then(() => {
                    this.watchDogCounter = 6;
                    if (!this.destroyed) this.setAvailable().catch(this.error);
                    return true;
                  })
                  .catch(() => false);
              }
              if (retryWorked) {
                item.resolve(true);
              } else {
                this.error(`${item.command} failed`, msg);
                this.watchDogCounter -= 1;
                item.reject(error);
              }
            });
          // eslint-disable-next-line no-await-in-loop
          await setTimeoutPromise((ITEM_WAIT_SECONDS[item.command] || 5) * 1000, 'waiting is done');
          if (this.destroyed || this.queueGeneration !== generation) return;
          item = this.deQueue();
        }
        needsFollowUpPoll = this.lastCommand !== 'doPoll';
      } catch (error) {
        this.error(error.message);
      } finally {
        // Only if this loop is still the current one — see queueGeneration above.
        if (this.queueGeneration === generation) {
          this.queueRunning = false;
          this.busy = false;
        }
      }
      // Enqueued here, after queueRunning is back to false — enqueuing it
      // inside the try block above left it stranded: enQueue() only starts
      // a fresh runQueue() when !queueRunning, which wasn't true yet there.
      // A stranded poll would then sit until some unrelated later command
      // triggered the queue again, jumping the queue ahead of it (FIFO).
      if (needsFollowUpPoll && this.queueGeneration === generation) {
        this.enQueue({ command: 'doPoll', args: { forceOnce: true, logPoll: false } }).catch(() => {});
      }
    };
  }

  // dispatches a queued command straight to the VehicleManager (this.client)
  // for the paired vehicle (this.vehicleConfig) — see ../../lib/connect/NAMING.md.
  runCommand(command, args) {
    const vc = this.vehicleConfig;
    switch (command) {
      case 'start': return this.client.startClimate(vc, args);
      case 'stop': return this.client.stopClimate(vc);
      case 'lock': return this.client.lock(vc);
      case 'unlock': return this.client.unlock(vc);
      case 'startCharge': return this.client.startCharge(vc);
      case 'stopCharge': return this.client.stopCharge(vc);
      case 'setChargeTargets': return this.client.setChargeLimits(vc, args.slow, args.fast);
      case 'setNavigation': return this.client.setNavigation(vc, args);
      case 'flashLights': return this.client.startHazardLights(vc);
      case 'flashLightsAndHonk': return this.client.startHazardLightsAndHorn(vc);
      case 'openChargePort': return this.client.chargePortAction(vc, CHARGE_PORT_ACTION.OPEN);
      case 'closeChargePort': return this.client.chargePortAction(vc, CHARGE_PORT_ACTION.CLOSE);
      case 'openWindows': return this.client.setWindowsState(vc, allWindows(WINDOW_STATE.OPEN));
      case 'closeWindows': return this.client.setWindowsState(vc, allWindows(WINDOW_STATE.CLOSED));
      case 'ventWindows': return this.client.setWindowsState(vc, allWindows(WINDOW_STATE.VENTILATION));
      case 'setChargingCurrent': return this.client.setChargingCurrent(vc, args);
      case 'setV2LDischargeLimit': return this.client.setVehicleToLoadDischargeLimit(vc, args);
      case 'enableValetMode': return this.client.valetModeAction(vc, VALET_MODE_ACTION.ACTIVATE);
      case 'disableValetMode': return this.client.valetModeAction(vc, VALET_MODE_ACTION.DEACTIVATE);
      case 'scheduleChargingAndClimate': return this.client.scheduleChargingAndClimate(vc, args);
      default: return Promise.reject(Error(this.homey.__('error_unknown_command', { command })));
    }
  }

  // setup the Kia/Hyundai connect client (lib/connect)
  async setupClient() {
    const options = {
      username: this.settings.username,
      password: this.settings.password,
      region: this.settings.region,
      language: this.settings.language || 'en', // ['cs', 'da', 'nl', 'en', 'fi', 'fr', 'de', 'it', 'pl', 'hu', 'no', 'sk', 'es', 'sv']
      pin: this.settings.pin,
      brand: this.homey.manifest.id.replace('com.', ''), // 'kia' or 'hyundai'
      logger: { log: this.log.bind(this), error: this.error.bind(this) },
    };
    this.client = createClient(options);

    let vehicleConfigs;
    try {
      vehicleConfigs = await this.client.login();
    } catch (error) {
      // Typed exceptions (see checkResponseForErrors) — .message is the bare
      // resMsg text, not raw JSON, so check the type rather than a
      // '"resCode":"..."' substring that never appears in it.
      if (error instanceof exceptions.RateLimitingError) {
        this.log('Daily quotum reached! Pausing app for 60 minutes.');
        this.stopPolling();
        this.setUnavailable(this.homey.__('device_quota_reached')).catch(this.error);
        this.restartDevice(60 * 60 * 1000).catch((e) => this.error(e));
      }
      if (error instanceof exceptions.DuplicateRequestError) {
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
        this.restartDevice(60 * 60 * 1000, message).catch((e) => this.error(e));
      } else if (error instanceof exceptions.AuthenticationError) {
        const message = this.homey.__('device_auth_failed');
        this.log(message);
        this.setUnavailable(message).catch(this.error);
        this.restartDevice(15 * 60 * 1000, message).catch((e) => this.error(e));
      }
      this.error(error);
      this.watchDogCounter -= 1;
      // this.vehicleConfig is always still null here: initvalues() resets it
      // on every onInit(), and it's only assigned below after a successful
      // login + vehicle match, which by definition hasn't happened yet.
      //
      // Back off exponentially: this restart re-enters onInit() -> setupClient()
      // -> login(), so an error with no typed branch above (a network error
      // during a server outage, most often) otherwise retries at a flat 15s
      // forever — ~240 full logins an hour against an API with a daily quota,
      // with nothing to stop it (onInit()'s own restartDevice() early-returns
      // on this.restarting, and initvalues() resets watchDogCounter to 6 on
      // every pass). The counter deliberately lives outside initvalues() so it
      // survives those restarts, and is cleared on the next successful login.
      this.loginFailures = (this.loginFailures || 0) + 1;
      const backoff = Math.min(15 * 1000 * (2 ** (this.loginFailures - 1)), LOGIN_BACKOFF_MAX_MS);
      this.log(`login failed ${this.loginFailures}x, retrying in ${backoff / 1000} seconds`);
      this.restartDevice(backoff).catch((e) => this.error(e));
      throw error;
    }
    if (this.destroyed) return;

    const vehicleConfig = vehicleConfigs.find((vc) => vc.vin === this.settings.vin);
    if (!vehicleConfig) {
      const message = this.homey.__('device_no_vehicle', { vin: this.settings.vin });
      this.error(`${message} (${vehicleConfigs.length} vehicle(s) returned for this account)`);
      this.setUnavailable(message).catch(this.error);
      // Propagates through this method, so onInit()'s catch picks it up and
      // retries every 10 minutes — recovers automatically if the car gets
      // shared again, instead of silently polling with no vehicle.
      // userMessage lets onInit()'s catch keep showing this specific reason
      // (instead of the generic "Device is restarting") during the wait.
      const error = Error(message);
      error.userMessage = message;
      throw error;
    }
    if (this.vehicleConfig === null) this.log(JSON.stringify(vehicleConfig));
    this.vehicleConfig = vehicleConfig;
    this.loginFailures = 0;
  }

  async startPolling(interval) {
    this.homey.clearInterval(this.intervalIdDevicePoll);
    if (this.destroyed) return;
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
      this.enQueue({ command: 'doPoll', args: { forceOnce: false, logPoll: false } }).catch(() => {});
    }, 1000 * 60 * interval);
    // do first poll
    this.enQueue({ command: 'doPoll', args: { forceOnce: false, logPoll: true } }).catch(() => {});
    // await setTimeoutPromise(15 * 1000);
    // this.lastStatus = null; // reset lastStatus to force logging a full status poll
    // this.enQueue({ command: 'doPoll', args: true });
  }

  stopPolling() {
    this.log(`Stop polling ${this.getName()}`);
    this.homey.clearInterval(this.intervalIdDevicePoll);
  }

  async restartDevice(delay, reason) {
    if (this.restarting || this.destroyed) return;
    this.restarting = true;
    this.stopPolling();
    this.flushQueue();
    const dly = delay || 1000 * 60 * 5;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    this.setUnavailable(reason || this.homey.__('device_restarting')).catch(this.error);
    // Kept as a cancellable id rather than an awaited sleep: homey.setTimeout
    // only disposes the timer when the whole Homey instance is destroyed (app
    // unload) — never when this one device is deleted. A pending restart runs
    // up to 60 minutes (quota/OTP), so without cancelRestart() below, deleting
    // a car mid-wait would still re-enter onInit() and log back in on its
    // behalf.
    this.restartTimeout = this.homey.setTimeout(() => {
      this.onInit().catch((error) => this.error(error));
    }, dly);
  }

  // Set once the instance is on its way out (deleted, or uninitialized by
  // Homey) and never cleared — Homey builds a fresh Device instance when a
  // device comes back, so nothing legitimately resumes on this one. Async work
  // already in flight when that happens (a login, a queued command, the 60s
  // duplicate-retry sleep) can't be aborted mid-await, so every step that
  // would touch Homey or the vehicle API after an await checks this first
  // instead of erroring against a dead device.
  markDestroyed() {
    this.destroyed = true;
    this.cancelRestart();
    this.stopPolling();
    this.flushQueue();
  }

  cancelRestart() {
    if (!this.restartTimeout) return;
    this.log(`cancelling pending restart of ${this.getName()}`);
    this.homey.clearTimeout(this.restartTimeout);
    this.restartTimeout = null;
    this.restarting = false;
  }

  async onUninit() {
    this.log('unInit', this.getName());
    this.markDestroyed();
    await setTimeoutPromise(2000).catch((error) => this.error(error)); // wait 2 secs
  }

  // this method is called when the Device is added
  async onAdded() {
    this.log(`Car added: ${this.getName()}`);
  }

  // this method is called when the Device is deleted. Homey calls onUninit()
  // on deletion too, so this teardown is redundant — kept as belt and braces,
  // markDestroyed() is idempotent.
  onDeleted() {
    this.markDestroyed();
    // this.destroyListeners();
    this.log(`Car deleted: ${this.getName()}`);
  }

  onRenamed(name) {
    this.log(`Car renamed to: ${name}`);
  }

  // this method is called when the user has changed the device's settings in Homey.
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed', this.getName(), newSettings);
    this.restartDevice(500).catch((error) => this.error(error));
  }

  setCapability(capability, value) {
    if (this.destroyed) return;
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
      const batSoCGood = this.lastStatus?.['measure_battery.12V'] > this.settings.batteryAlarmLevel;
      const refresh = this.pollMode // 1 = engineOn with refresh
        || (batSoCGood && (forceOnce || forcePollInterval)); // || !status || !location || !odometer));

      const fullStatus = refresh
        ? await this.client.forceRefreshVehicleState(this.vehicleConfig)
        : await this.client.updateVehicleWithCachedState(this.vehicleConfig);
      // The call above can outlive the device (deletion, app unload); anything
      // below writes capabilities, the store or flow triggers.
      if (this.destroyed) return;

      // CCS2 status always includes Location inline; legacy (non-ccuCCS2)
      // vehicles sometimes don't — fetch it separately when missing.
      if (!this.vehicleConfig.ccuCCS2ProtocolSupport && !fullStatus.vehicleLocation) {
        await setTimeoutPromise(5000);
        const gpsDetail = await this.client.getLocation(this.vehicleConfig).catch((error) => this.error(error));
        fullStatus.vehicleLocation = { coord: gpsDetail?.coord || {} };
      }

      // log a redacted snapshot on the first poll after every app (re)start, so
      // it ends up in a diagnostics report after a user is asked to restart the
      // app and send one; see lib/connect/native/debugDump.js and
      // zzz_responses/db/README.md for what to do with it afterwards.
      if (logPoll) {
        // energy-consumption stats live on a separate endpoint (only
        // meaningful for EV/PHEV); best-effort, must not break the regular
        // status dump if it's unsupported or fails for this vehicle.
        let drivingInfo;
        if (this.isEV) {
          drivingInfo = await this.client.drivingInfo(this.vehicleConfig).catch((error) => {
            this.error('drivingInfo (debug dump only) failed', error);
            return undefined;
          });
        }
        const dump = buildVehicleDebugDump({
          brand: this.homey.manifest.id.replace('com.', ''),
          region: this.settings.region,
          engine: this.settings.engine,
          generation: this.settings.generation,
          ccuCCS2ProtocolSupport: this.settings.ccuCCS2ProtocolSupport,
          vehicleConfig: this.vehicleConfig,
          status: fullStatus,
          odometer: fullStatus?.odometer,
          drivingInfo,
        });
        this.log('===VEHICLE-DEBUG-DUMP-START===');
        this.log(JSON.stringify(dump));
        this.log('===VEHICLE-DEBUG-DUMP-END===');
      }
      // console.dir(fullStatus, { depth: null, colors: true, showHidden: true });
      const stsMapped = await this.mapStatus(fullStatus);
      await DeviceMigrator.syncDistanceUnits(this, this.imperialDistance).catch((error) => this.error(error));
      await DeviceMigrator.syncSpeedUnits(this, this.imperialDistance).catch((error) => this.error(error));
      await DeviceMigrator.syncFuelEconomyUnits(this, this.fuelEconomyUnit, this.imperialDistance).catch((error) => this.error(error));
      if (stsMapped.Date !== this.lastStatus?.Date) {
        this.log(`${this.getName()} Server info changed. ${this.lastStatus?.Date} ${stsMapped.Date}`);
        // console.dir(fullStatus, { depth: null });
        this.lastRefresh = Date.now();
      }

      // repair odometer status 0: fall back to the last known reading instead
      // of leaving it unset (spreading a number here produced an empty object,
      // which Homey then rejected as an invalid measure_odo capability value)
      if (!stsMapped.measure_odo) stsMapped.measure_odo = this.lastStatus?.measure_odo;

      this.lastStatus = stsMapped;
      await this.setStoreValue('lastStatus', stsMapped).catch((error) => this.error(error));
      await this.recordSeenCaps(stsMapped).catch((error) => this.error(error));

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

      // variable polling interval based on active state
      if (this.settings.pollIntervalEngineOn && !this.pollMode && carJustActive) {
        this.pollMode = 1; // engineOn poll mode
        this.startPolling(this.settings.pollIntervalEngineOn).catch((error) => this.error(error));
      } else if (this.pollMode && !carJustActive) {
        this.pollMode = 0; // normal poll mode
        this.startPolling(this.settings.pollInterval).catch((error) => this.error(error));
      }

      return true;
    } catch (error) {
      this.error(error);
      this.setCapability('refresh_status', false);
      throw error;
    }
  }

  async handleInfo(info) {
    try {

      const moving = this.isMoving(info);
      this.moving = moving; // read by the 'moving' flow condition card (app.js)
      const hasParked = this.isParking(info);

      // update capabilities
      for (const [cap, val] of Object.entries(info)) {
        this.setCapability(cap, val);
      }
      if (this.lastRefresh) {
        const ds = new Date(this.lastRefresh);
        const timeZone = this.homey.clock.getTimezone();
        const date = ds.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone });
        const time = ds.toLocaleTimeString('nl-NL', { hour12: false, timeZone }).substring(0, 5);
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
  // Converts a per-field distance value to this.imperialDistance's target
  // unit using that field's OWN reported unit code, so a field whose tag
  // disagrees with the account's detected unit (e.g. odometer tagged km
  // while range is tagged mi within the same status response, seen on some
  // UK accounts) still displays correctly instead of a mislabeled raw value.
  normalizeDistance(value, unitCode) {
    if (typeof value !== 'number') return value;
    const fieldIsImperial = isImperialUnit(unitCode);
    if (this.imperialDistance && !fieldIsImperial) return kmToMi(value);
    if (!this.imperialDistance && fieldIsImperial) return miToKm(value);
    return value;
  }

  async mapStatus(status) {
    const map = {};
    if (!status) return map;
    let sts = { ...status }; // clone status
    // Legacy tags distance fields per-field on odometer/range; CCS2 only on
    // Drivetrain.FuelSystem.DTE.Unit — CCS2 odometer has no per-field unit,
    // so it's assumed to follow DTE's. Range is checked before odometer: on
    // some UK accounts (e.g. Inster) the odometer field's own unit tag is
    // unreliably km while range is consistently mi (matching what the
    // Hyundai/Kia app itself shows) — every other known sample has both
    // fields agree, so this ordering is a no-op elsewhere. Must run before
    // the odometer value below is read, and stays on `this` for doPoll()'s
    // post-mapStatus sync. normalizeDistance() below then numerically
    // corrects any single field whose own tag still disagrees with this.
    this.imperialDistance = isImperialUnit(
      status?.vehicleStatus?.evStatus?.drvDistance?.[0]?.rangeByFuel?.totalAvailableRange?.unit
      ?? status?.odometer?.unit
      ?? status?.Drivetrain?.FuelSystem?.DTE?.Unit,
    );
    // is old type full status
    if (sts.vehicleStatus) {
      map.measure_odo = this.normalizeDistance(sts?.odometer?.value, sts?.odometer?.unit);
      if (typeof map.measure_odo === 'number') map.measure_odo = Math.round(map.measure_odo * 10) / 10;
      map.latitude = sts?.vehicleLocation?.coord?.lat;
      map.longitude = sts?.vehicleLocation?.coord?.lon;
      const speed = sts?.vehicleLocation?.speed?.value;
      // Same {value, unit} shape as odometer/range. Only unit codes 0/1 seen
      // live so far (never 2/3, i.e. never an actual mph speed reading) - but
      // it's the same API family/field shape as the confirmed odometer/range
      // unit table (see normalizeDistance() above), so treated as the same
      // convention by analogy rather than left unconverted. km/h<->mph is the
      // same ratio as km<->mi, so normalizeDistance() applies unchanged.
      map.measure_speed = this.normalizeDistance(speed > 255 ? 0 : speed, sts?.vehicleLocation?.speed?.unit);
      let meterDistance = this.distance(map); // always km, computed from lat/lon
      if (this.imperialDistance) meterDistance = kmToMi(meterDistance);
      map.meter_distance = Math.round(meterDistance * 10) / 10;
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
      // Legacy field names/casing (incl. Kia's own "break" typo for "brake")
      // — only reported by some non-CCS2 models (e.g. Sorento PHEV), absent
      // on others (e.g. Niro EV/HEV) where these just stay unset.
      map['alarm_generic.washer_fluid'] = sts?.washerFluidStatus;
      map['alarm_generic.brake_fluid'] = sts?.breakOilStatus;
      map['alarm_generic.key_fob_battery'] = sts?.smartKeyBatteryWarning;
      map['measure_battery.12V'] = sts?.battery?.batSoc;
      map['measure_battery.health'] = sts?.evStatus?.batterySoh;
      const rangeField = sts?.evStatus?.drvDistance?.[0]?.rangeByFuel?.totalAvailableRange;
      const rangeValue = rangeField?.value || sts?.dte?.value;
      const rangeUnit = rangeField?.value ? rangeField?.unit : sts?.dte?.unit;
      map.measure_range = this.normalizeDistance(rangeValue, rangeUnit);
      if (typeof map.measure_range === 'number' && map.measure_range >= 0) map.measure_range = Math.round(map.measure_range * 10) / 10;
      else map.measure_range = null; // Sorento weird server response
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
      // Scheduled departure (issue #24). Legacy reservChargeInfos exposes two
      // slots — reservChargeInfo + reserveChargeInfo2 (upstream's "reserve"
      // typo). Times are 12-hour "HHMM" + AM/PM timeSection, already local
      // car time; reservInfo.day is a 0-6 weekday list (Sun=0, matching the
      // write side and Date#getDay), or the [9] "unset" sentinel.
      const reserv = sts?.evStatus?.reservChargeInfos;
      // Kept raw for the departure_schedule.* toggles / enable_departure_schedule_*
      // flow cards — the API has no per-slot toggle, so enabling/disabling one
      // slot means re-POSTing the whole schedule (see buildScheduleOptions()).
      this.rawReservation = reserv ? { kind: 'legacy', data: reserv } : null;
      const departureSlots = this.departureSlots();
      map.departure_time = this.formatDeparture(departureSlots);
      map['departure_schedule.1'] = !!departureSlots[0]?.enabled;
      map['departure_schedule.2'] = !!departureSlots[1]?.enabled;
      map['alarm_bat'] = (sts?.battery?.batSoc < this.settings.batteryAlarmLevel) || (sts?.evStatus?.batteryStatus < this.settings.EVbatteryAlarmLevel);
      map.Date = sts.time;
    }
    // is new type status
    if (sts.Date) {
      map.measure_odo = sts?.Drivetrain?.Odometer;
      if (typeof map.measure_odo === 'number') map.measure_odo = Math.round(map.measure_odo * 10) / 10;
      map.latitude = sts?.Location?.GeoCoord?.Latitude;
      map.longitude = sts?.Location?.GeoCoord?.Longitude;
      const speed = sts?.Location?.Speed?.Value;
      // Same reasoning as the legacy vehicleLocation.speed handling above -
      // Location.Speed.Unit is only ever seen as 0 live so far, treated as
      // the same km/mi unit-code convention by analogy.
      map.measure_speed = this.normalizeDistance(speed > 255 ? 0 : speed, sts?.Location?.Speed?.Unit);
      let ccs2MeterDistance = this.distance(map); // always km, computed from lat/lon
      if (this.imperialDistance) ccs2MeterDistance = kmToMi(ccs2MeterDistance);
      map.meter_distance = Math.round(ccs2MeterDistance * 10) / 10;
      const carLocString = await geo.getCarLocString(map).catch((error) => this.error(error)); // ReverseGeocoding
      map.location = carLocString?.local;
      map.address = carLocString?.address;

      // determine chargeState
      map['measure_power.charge'] = sts?.Green?.Electric?.SmartGrid?.RealTimePower * 1000;
      // Only unit 4 (km/kWh) is confirmed enough to convert numerically for
      // imperial (see lib/DeviceMigrator.js's FUEL_ECONOMY_UNITS comment);
      // other units are relabeled only, via syncFuelEconomyUnits().
      this.fuelEconomyUnit = sts?.Drivetrain?.FuelSystem?.AverageFuelEconomy?.Unit;
      let fuelEconomy = sts?.Drivetrain?.FuelSystem?.AverageFuelEconomy?.Drive;
      if (typeof fuelEconomy === 'number' && this.fuelEconomyUnit === 4 && this.imperialDistance) {
        fuelEconomy = kmToMi(fuelEconomy);
      }
      map['meter_power.fuel_economy'] = fuelEconomy;
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
      const targetTempUnit = sts?.Cabin?.HVAC?.Row1?.Driver?.Temperature?.Unit; // 0=C, 1=F
      if (typeof targetTemp === 'string' && !Number.isNaN(Number(targetTemp))) {
        targetTemp = Number(targetTemp);
      }
      if (typeof targetTemp === 'number' && targetTempUnit === 1) targetTemp = convert.fahrenheitToCelsius(targetTemp);
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
      const tires = [
        sts?.Chassis?.Axle?.Row1?.Left?.Tire,
        sts?.Chassis?.Axle?.Row1?.Right?.Tire,
        sts?.Chassis?.Axle?.Row2?.Left?.Tire,
        sts?.Chassis?.Axle?.Row2?.Right?.Tire,
      ].filter(Boolean);
      map['alarm_tire_pressure'] = !!sts?.Chassis?.Axle?.Tire?.PressureLow || tires.some((tire) => tire.PressureLow);
      map['alarm_generic.washer_fluid'] = !!sts?.Body?.Windshield?.Front?.WasherFluid?.LevelLow;
      map['alarm_generic.brake_fluid'] = !!sts?.Chassis?.Brake?.Fluid?.Warning;
      map['alarm_generic.key_fob_battery'] = !!sts?.Electronics?.FOB?.LowBattery;
      map['measure_battery.12V'] = sts?.Electronics?.Battery?.Level;
      map['measure_battery.health'] = sts?.Green?.BatteryManagement?.SoH?.Ratio;
      map.measure_range = sts?.Drivetrain?.FuelSystem?.DTE.Total;
      if (typeof map.measure_range === 'number') map.measure_range = Math.round(map.measure_range * 10) / 10;
      map.measure_battery = sts?.Green?.BatteryManagement?.BatteryRemain.Ratio;
      map.charge = charge;
      map.charge_target_slow = sts?.Green?.ChargingInformation?.TargetSoC?.Standard.toString();
      map.charge_target_fast = sts?.Green?.ChargingInformation?.TargetSoC?.Quick.toString();
      map.ev_charging_state = evChargingState;
      // Scheduled departure (issue #24). CCS2 exposes two slots under
      // Green.Reservation.Departure; Schedule={"Enable": false} with no
      // Hour/Min (EV9) and the 31:70 sentinel (ccNC EVs) both resolve to
      // no time. Times are already local car time.
      // Kept raw for the departure_schedule.* toggles, see the legacy branch
      // above and buildScheduleOptions().
      this.rawReservation = sts?.Green?.Reservation ? { kind: 'ccs2', data: sts.Green.Reservation } : null;
      const ccs2DepartureSlots = this.departureSlots();
      map.departure_time = this.formatDeparture(ccs2DepartureSlots);
      map['departure_schedule.1'] = !!ccs2DepartureSlots[0]?.enabled;
      map['departure_schedule.2'] = !!ccs2DepartureSlots[1]?.enabled;
      map['alarm_bat'] = (map['measure_battery.12V'] < this.settings.batteryAlarmLevel) || (map.measure_battery < this.settings.EVbatteryAlarmLevel);
      map.Date = sts.Date;
    }
    return map;
  }

  // The two departure slots as { enabled, time: {hours,minutes}|null, days }
  // from this.rawReservation (legacy or CCS2), for formatDeparture() and the
  // departure_schedule.* toggles. Empty when there's no reservation data.
  departureSlots() {
    const raw = this.rawReservation;
    if (!raw?.data) return [];
    if (raw.kind === 'legacy') {
      const d = raw.data;
      const slot = (detail) => ({
        enabled: !!detail?.reservChargeSet,
        time: legacyReservationTimeOrNone(detail?.reservInfo?.time?.time, detail?.reservInfo?.time?.timeSection),
        days: detail?.reservInfo?.day,
      });
      return [slot(d.reservChargeInfo?.reservChargeInfoDetail), slot(d.reserveChargeInfo2?.reservChargeInfoDetail)];
    }
    const dep = raw.data.Departure;
    const slot = (s) => ({
      enabled: s?.Enable === 1 || s?.Enable === true,
      time: ccs2ReservationTimeOrNone(s?.Hour, s?.Min),
      days: ccs2DepartureDays(s),
    });
    return [slot(dep?.Schedule1), slot(dep?.Schedule2)];
  }

  // Formats the soonest upcoming departure across all enabled slots as its
  // next concrete occurrence ("Aug 31 07:00"), same format as last_refresh,
  // or the localized "not set" text when no slot is active / every time is a
  // sentinel (issue #24). Both slots can be enabled with different times
  // (e.g. 07:00 and 17:00) — the one that comes first wins, which flips
  // through the day. Homey never translates a capability's value, so the
  // "not set" string is built here via this.homey.__(). nextDepartureOccurrence
  // returns a Date carrying the local wall-clock in its UTC fields — hence
  // timeZone: 'UTC' below.
  formatDeparture(slots) {
    const timeZone = this.homey.clock.getTimezone();
    const [next] = slots
      .filter((slot) => slot.enabled && slot.time)
      .map((slot) => nextDepartureOccurrence(slot.time, slot.days, timeZone))
      .filter(Boolean)
      .sort((a, b) => a - b);
    if (!next) return this.homey.__('departure_not_set');
    const date = next.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
    const time = next.toLocaleTimeString('nl-NL', { hour12: false, timeZone: 'UTC' }).substring(0, 5);
    return `${date} ${time}`;
  }

  // Rebuilds the full scheduleChargingAndClimate() options object from the
  // last polled reservation data (this.rawReservation, stashed in mapStatus).
  // The API has no per-slot toggle — enabling/disabling one departure means
  // re-POSTing the whole schedule, so every other field (both slots' time +
  // days, off-peak window, scheduled-charging flag, preheat) has to be echoed
  // back unchanged. Returns null when there's no reservation data yet.
  // Known lossiness (upstream's write model): preheat is one setting shared by
  // both slots (per-slot climate can't be expressed), and the off-peak flag is
  // written as 1/2 so a car reporting the "unconfigured" 0 becomes 2.
  buildScheduleOptions() {
    const r = this.rawReservation;
    if (!r || !r.data) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const asHHMM = (t) => (t ? `${pad(t.hours)}:${pad(t.minutes)}` : '00:00');

    if (r.kind === 'legacy') {
      const d = r.data;
      const slot = (detail) => {
        const day = Array.isArray(detail?.reservInfo?.day) ? detail.reservInfo.day : [];
        return {
          enabled: !!detail?.reservChargeSet,
          days: day.length ? day : [0],
          time: asHHMM(legacyReservationTimeOrNone(detail?.reservInfo?.time?.time, detail?.reservInfo?.time?.timeSection)),
          // A never-configured slot reports day: [9] + a sentinel time — not a
          // real schedule to turn on. A configured one has weekdays in 0-6.
          configured: day.some((d) => d >= 0 && d <= 6),
        };
      };
      const fatc = d.reservChargeInfo?.reservChargeInfoDetail?.reservFatcSet;
      let temperature = 21;
      try {
        const celsius = convert.getTempFromCode(fatc?.airTemp?.value);
        if (typeof celsius === 'number') temperature = celsius;
      } catch (error) { this.log('departure preheat temp out of range, using 21', error.message); }
      const op = d.offpeakPowerInfo?.offPeakPowerTime1;
      return {
        firstDeparture: slot(d.reservChargeInfo?.reservChargeInfoDetail),
        secondDeparture: slot(d.reserveChargeInfo2?.reservChargeInfoDetail),
        chargingEnabled: d.reservFlag === 1,
        offPeakChargeOnlyEnabled: d.offpeakPowerInfo?.offPeakPowerFlag === 1,
        offPeakStartTime: asHHMM(legacyReservationTimeOrNone(op?.starttime?.time, op?.starttime?.timeSection)),
        offPeakEndTime: asHHMM(legacyReservationTimeOrNone(op?.endtime?.time, op?.endtime?.timeSection)),
        climateEnabled: fatc?.airCtrl === 1,
        temperature,
        temperatureUnit: fatc?.airTemp?.unit ?? 0,
        defrost: !!fatc?.defrost,
      };
    }

    // CCS2 (Green.Reservation)
    const dep = r.data.Departure;
    if (!dep) return null;
    const slot = (s) => {
      const days = ccs2DepartureDays(s);
      return {
        enabled: s?.Enable === 1 || s?.Enable === true,
        days,
        time: asHHMM(ccs2ReservationTimeOrNone(s?.Hour, s?.Min)),
        configured: days.length > 0,
      };
    };
    const clim = dep.Climate || {};
    const temp = Number(clim.Temperature);
    const op = r.data.OffPeakTime || {};
    const opHHMM = (h, m) => ((Number.isInteger(h) && h >= 0 && h <= 23) ? `${pad(h)}:${pad(m || 0)}` : '00:00');
    return {
      firstDeparture: slot(dep.Schedule1),
      secondDeparture: slot(dep.Schedule2),
      chargingEnabled: op.Mode === 2 || op.Mode === 3,
      offPeakChargeOnlyEnabled: op.Mode === 3,
      offPeakStartTime: opHHMM(op.StartHour, op.StartMin),
      offPeakEndTime: opHHMM(op.EndHour, op.EndMin),
      climateEnabled: clim.Activation === 1,
      temperature: Number.isFinite(temp) && temp > 0 ? temp : 21,
      temperatureUnit: clim.TemperatureUnit ?? 0,
      defrost: clim.Defrost === 1,
    };
  }

  // Enable/disable one departure slot (index 1 or 2) — the departure_schedule.*
  // toggles and enable_departure_schedule_* flow cards. Reconstructs the whole
  // schedule and flips just that slot's flag (the API has no per-slot toggle).
  enableDepartureSchedule(index, enabled, source) {
    if (!this.isEV) throw Error(this.homey.__('error_not_ev'));
    const options = this.buildScheduleOptions();
    if (!options) throw Error(this.homey.__('error_no_schedule'));
    const key = index === 2 ? 'secondDeparture' : 'firstDeparture';
    if (enabled && !options[key].configured) throw Error(this.homey.__('error_schedule_not_configured'));
    options[key].enabled = enabled;
    delete options.firstDeparture.configured;
    delete options.secondDeparture.configured;
    this.log(`Departure schedule ${index} ${enabled ? 'enabled' : 'disabled'} via ${source}`);
    // Reflect it right away in the toggle + departure_time (a flow card sets
    // no capability itself, and even the tile toggle would otherwise sit
    // ahead of departure_time). The forced poll after the command re-derives
    // both from real status once the server catches up.
    const raw = this.rawReservation;
    if (raw?.kind === 'legacy') {
      const detail = (index === 2 ? raw.data.reserveChargeInfo2 : raw.data.reservChargeInfo)?.reservChargeInfoDetail;
      if (detail) detail.reservChargeSet = enabled;
    } else if (raw?.kind === 'ccs2') {
      const schedule = raw.data.Departure?.[`Schedule${index}`];
      if (schedule) schedule.Enable = enabled ? 1 : 0;
    }
    this.setCapability(`departure_schedule.${index}`, enabled);
    this.setCapability('departure_time', this.formatDeparture(this.departureSlots()));
    return this.enQueue({ command: 'scheduleChargingAndClimate', args: options });
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
    const lat1 = Number(location.latitude);
    const lon1 = Number(location.longitude);
    const lat2 = Number(this.settings.lat);
    const lon2 = Number(this.settings.lon);
    return Math.round(distanceKm(lat1, lon1, lat2, lon2) * 100) / 100;
  }

  // flowArgs.duration (minutes, optional) from the "Turn A/C on" flow card —
  // see ../../.homeycompose/flow/actions/ac_on.json. This is the plain
  // cooling command (summer use case): all heat options are always off,
  // both via the flow card and the "climate control" device-tile toggle
  // (source: 'app') — see defrostOnOff() for the preheat/defrost variant
  // that turns them on.
  acOnOff(acOn, source, flowArgs = {}) {
    if (this.getCapabilityValue('engine')) throw Error(this.homey.__('error_engine_on'));
    let command;
    let args;
    if (acOn) {
      this.log(`A/C on via ${source}`); // app or flow
      command = 'start';
      args = {
        setTemp: this.toApiSetTemp(this.getCapabilityValue('target_temperature') || 22),
        duration: flowArgs.duration ?? 10,
        defrost: false,
        steeringWheel: 0,
        heating: HEAT_STATUS.OFF,
        frontLeftSeat: SEAT_STATUS.OFF,
        frontRightSeat: SEAT_STATUS.OFF,
        rearLeftSeat: SEAT_STATUS.OFF,
        rearRightSeat: SEAT_STATUS.OFF,
      };
    } else {
      this.log(`A/C off via ${source}`); // app or flow
      command = 'stop';
      this.setCapability('defrost', false); // set defrost state to off
    }
    return this.enQueue({ command, args });
  }

  // flowArgs.duration (minutes, optional) from the "Turn defrost on" flow
  // card — see ../../.homeycompose/flow/actions/defrost_on.json. This is
  // the preheat/defrost command (winter use case): steering wheel and all
  // 4 seats are always heated too, both via the flow card and the
  // "defrost" device-tile toggle (source: 'app') — seat heat is CCS2-only,
  // startClimate() silently ignores it on older, non-CCS2 cars.
  defrostOnOff(defrost, source, flowArgs = {}) {
    if (this.getCapabilityValue('engine')) throw Error(this.homey.__('error_engine_on'));
    const command = defrost ? 'start' : 'stop';
    let args;
    if (defrost) {
      this.log(`defrost on via ${source}`);
      args = {
        defrost: true,
        heating: HEAT_STATUS.STEERING_WHEEL_AND_REAR_WINDOW,
        steeringWheel: 1,
        frontLeftSeat: SEAT_STATUS.MEDIUM_HEAT,
        frontRightSeat: SEAT_STATUS.MEDIUM_HEAT,
        rearLeftSeat: SEAT_STATUS.MEDIUM_HEAT,
        rearRightSeat: SEAT_STATUS.MEDIUM_HEAT,
        duration: flowArgs.duration ?? 10,
        setTemp: this.toApiSetTemp(this.getCapabilityValue('target_temperature') || 22),
      };
    } else {
      this.log(`defrost off via ${source}`);
      args = {
        defrost: false,
        heating: HEAT_STATUS.OFF,
        steeringWheel: 0,
        frontLeftSeat: SEAT_STATUS.OFF,
        frontRightSeat: SEAT_STATUS.OFF,
        rearLeftSeat: SEAT_STATUS.OFF,
        rearRightSeat: SEAT_STATUS.OFF,
      };
      // have to do it twice to get defrost reported as off; only the 2nd
      // result (returned below) is what the caller waits for
      this.enQueue({ command, args }).catch(() => {});
      this.setCapability('climate_control', false); // set AC state to off
    }
    return this.enQueue({ command, args });
  }

  chargingOnOff(charge, source) {
    if (!this.isEV) throw Error(this.homey.__('error_not_ev'));
    let command;
    if (charge) {
      this.log(`charging on via ${source}`);
      command = 'startCharge';
    } else {
      this.log(`charging off via ${source}`);
      command = 'stopCharge';
    }
    return this.enQueue({ command });
  }

  lock(locked, source) {
    let command;
    if (locked) {
      this.log(`locking doors via ${source}`);
      command = 'lock';
    } else {
      this.log(`unlocking doors via ${source}`);
      command = 'unlock';
    }
    return this.enQueue({ command });
  }

  // KiaUvoApiUSA.js / HyundaiBlueLinkApiUSA.js's startClimate() (ported
  // faithfully from upstream, which has the same assumption - its caller,
  // Home Assistant, supplies Fahrenheit there) expects options.setTemp
  // already in Fahrenheit for the 'US' region. Every other region's
  // startClimate() expects Celsius, matching target_temperature (Homey's
  // stock capability - always Celsius, per Homey's platform contract), so
  // only 'US' needs converting here before a command is sent.
  toApiSetTemp(celsius) {
    return this.settings.region === 'US' ? convert.celsiusToFahrenheit(celsius) : celsius;
  }

  setTargetTemp(temp, source) {
    if (this.getCapabilityValue('engine')) throw Error(this.homey.__('error_engine_on'));
    if (!this.getCapabilityValue('climate_control')) throw Error(this.homey.__('error_climate_control_off'));
    this.log(`Temperature set by ${source} to ${temp}`);
    const args = { setTemp: this.toApiSetTemp(temp || 22) };
    const command = 'start';
    return this.enQueue({ command, args });
  }

  setChargeTargets(targets = { fast: 100, slow: 80 }, source) {
    if (!this.isEV) throw Error(this.homey.__('error_not_ev'));
    this.log(`Charge target is set by ${source} to slow:${targets.slow} fast:${targets.fast}`);
    const args = { fast: Number(targets.fast), slow: Number(targets.slow) };
    const command = 'setChargeTargets';
    return this.enQueue({ command, args });
  }

  flashLights(honk, source) {
    this.log(`Flash lights${honk ? ' + horn' : ''} via ${source}`);
    const command = honk ? 'flashLightsAndHonk' : 'flashLights';
    return this.enQueue({ command });
  }

  chargePortOpen(open, source) {
    if (!this.isEV) throw Error(this.homey.__('error_not_ev'));
    this.log(`Charge port ${open ? 'open' : 'close'} via ${source}`);
    const command = open ? 'openChargePort' : 'closeChargePort';
    return this.enQueue({ command });
  }

  setWindows(state, source) { // state: 'open', 'closed' or 'vent'
    this.log(`Windows set to ${state} via ${source}`);
    const command = { open: 'openWindows', closed: 'closeWindows', vent: 'ventWindows' }[state];
    if (!command) throw Error(this.homey.__('error_invalid_window_state', { state }));
    return this.enQueue({ command });
  }

  setChargingCurrent(level, source) {
    if (!this.isEV) throw Error(this.homey.__('error_not_ev'));
    this.log(`Charging current set by ${source} to ${level}`);
    return this.enQueue({ command: 'setChargingCurrent', args: Number(level) });
  }

  setV2LDischargeLimit(limit, source) {
    if (!this.isEV) throw Error(this.homey.__('error_not_ev'));
    this.log(`V2L discharge limit set by ${source} to ${limit}`);
    return this.enQueue({ command: 'setV2LDischargeLimit', args: Number(limit) });
  }

  setValetMode(enabled, source) {
    this.log(`Valet mode ${enabled ? 'enabled' : 'disabled'} via ${source}`);
    const command = enabled ? 'enableValetMode' : 'disableValetMode';
    return this.enQueue({ command });
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
    return this.enQueue({ command, args });
  }

  async refreshStatus(refresh, source) {
    if (!refresh) return true;
    // Same guard doPoll() applies to an auto/forced poll (see forcePollInterval
    // there) - but a user explicitly pressing this button/flow action deserves a
    // real error instead of doPoll() silently downgrading to a cached-only read.
    const batSoc = this.lastStatus?.['measure_battery.12V'];
    const level = this.settings.batteryAlarmLevel;
    if (!(batSoc > level)) {
      this.log(`Refusing forced refresh via ${source}: 12V battery too low or unknown (${batSoc}% <= ${level}%)`);
      throw Error(this.homey.__('error_battery_too_low_for_refresh', { batSoc: batSoc ?? '?', level }));
    }
    this.setCapability('refresh_status', true);
    this.log(`Forcing status refresh via ${source}`);
    if (source === 'app' || source === 'cloud') this.carLastActive = Date.now();
    return this.enQueue({ command: 'doPoll', args: { forceOnce: true, logPoll: false } });
  }

  // register capability listeners
  startListeners() {
    // Outside the listenersSet latch below, and re-checked on every onInit():
    // this is the only registration gated on hasCapability(), and
    // departure_schedule.* can be added to a device *after* its first
    // onInit() — by onRepair() re-bucketing a car to 'Full EV ccuCCS2', or by
    // migrate() on an app update. restartDevice() re-enters onInit() on the
    // same Device instance rather than constructing a new one, so the latch
    // stayed true and these listeners were never registered: the toggles show
    // up in the UI and nothing is sent to the car until the whole app
    // restarts. Latched separately so it still registers only once.
    if (this.hasCapability('departure_schedule.1') && !this.departureListenersSet) {
      this.registerCapabilityListener('departure_schedule.1', (enabled) => this.enableDepartureSchedule(1, enabled, 'app'));
      this.registerCapabilityListener('departure_schedule.2', (enabled) => this.enableDepartureSchedule(2, enabled, 'app'));
      this.departureListenersSet = true;
    }
    if (!this.listenersSet) {
      this.log(`${this.getName()} starting capability listeners`);
      // capabilityListeners will be overwritten, so no need to unregister them
      this.registerCapabilityListener('locked', (locked) => this.lock(locked, 'app'));
      this.registerCapabilityListener('defrost', (defrost) => this.defrostOnOff(defrost, 'app'));
      this.registerCapabilityListener('climate_control', (acOn) => this.acOnOff(acOn, 'app'));
      // A real on/off state on the car (like climate_control/defrost above),
      // not a momentary trigger — but unlike those, there's no status field
      // to poll it back from (absent in every zzz_responses capture), so it
      // can't self-correct if valet mode is toggled from the car itself.
      this.registerCapabilityListener('valet_mode', (enabled) => this.setValetMode(enabled, 'app'));
      this.registerCapabilityListener('target_temperature', async (temp) => this.setTargetTemp(temp, 'app'));
      this.registerCapabilityListener('refresh_status', (refresh) => this.refreshStatus(refresh, 'app'));
      this.registerCapabilityListener('charge', (charge) => this.chargingOnOff(charge, 'app'));
      // Momentary buttons — self-reset back to false after the command
      // completes (or the enQueue timeout races it), matching refresh_status.
      this.registerCapabilityListener('vent_windows', (pressed) => {
        if (!pressed) return true;
        return this.setWindows('vent', 'app').finally(() => this.setCapability('vent_windows', false));
      });
      this.registerCapabilityListener('flash_lights', (pressed) => {
        if (!pressed) return true;
        return this.flashLights(false, 'app').finally(() => this.setCapability('flash_lights', false));
      });
      this.registerCapabilityListener('flash_lights_and_honk', (pressed) => {
        if (!pressed) return true;
        return this.flashLights(true, 'app').finally(() => this.setCapability('flash_lights_and_honk', false));
      });
      this.registerMultipleCapabilityListener(['charge_target_slow', 'charge_target_fast'], async (values) => {
        const slow = Number(values.charge_target_slow) || Number(this.getCapabilityValue('charge_target_slow'));
        const fast = Number(values.charge_target_fast) || Number(this.getCapabilityValue('charge_target_fast'));
        const targets = { slow, fast };
        return this.setChargeTargets(targets, 'app');
      }, 10000);
      this.listenersSet = true;
    }
  }

}

module.exports = CarDevice;
