'use strict';

const fs = require('fs');
const path = require('path');

let defaultImageBase64 = null;

async function getDefaultCarImage() {
  if (!defaultImageBase64) {
    try {
      const imgPath = path.join(__dirname, '../../drivers/car/assets/images/large.png');
      const buffer = await fs.promises.readFile(imgPath);
      defaultImageBase64 = `data:image/png;base64,${buffer.toString('base64')}`;
    } catch {
      defaultImageBase64 = '';
    }
  }
  return defaultImageBase64;
}

module.exports = {
  async getCarData({ homey, query }) {
    const driver = homey.drivers.getDriver('car');
    if (!driver) {
      return null;
    }

    const devices = driver.getDevices();
    let device;

    if (query && query.deviceId) {
      const targetId = String(query.deviceId).trim();
      device = devices.find((d) => {
        const data = (typeof d.getData === 'function' && d.getData()) || {};
        return String(d.id) === targetId || String(data.id) === targetId;
      });
    }

    if (!device && devices.length > 0) {
      device = devices[0];
    }

    if (!device) {
      return null;
    }

    const defaultImage = await getDefaultCarImage();

    return {
      id: (typeof device.getData === 'function' && device.getData()?.id) || device.id,
      name: device.getName(),
      measure_battery: device.hasCapability('measure_battery') ? device.getCapabilityValue('measure_battery') : null,
      'measure_battery.12V': device.hasCapability('measure_battery.12V') ? device.getCapabilityValue('measure_battery.12V') : null,
      measure_range: device.hasCapability('measure_range') ? device.getCapabilityValue('measure_range') : null,
      closed_locked: device.hasCapability('closed_locked') ? device.getCapabilityValue('closed_locked') : null,
      locked: device.hasCapability('locked') ? device.getCapabilityValue('locked') : null,
      engine: device.hasCapability('engine') ? device.getCapabilityValue('engine') : null,
      climate_control: device.hasCapability('climate_control') ? device.getCapabilityValue('climate_control') : null,
      target_temperature: device.hasCapability('target_temperature') ? device.getCapabilityValue('target_temperature') : null,
      ev_charging_state: device.hasCapability('ev_charging_state') ? device.getCapabilityValue('ev_charging_state') : null,
      charge: device.hasCapability('charge') ? device.getCapabilityValue('charge') : null,
      'measure_power.charge': device.hasCapability('measure_power.charge') ? device.getCapabilityValue('measure_power.charge') : null,
      location: device.hasCapability('location') ? device.getCapabilityValue('location') : '',
      meter_distance: device.hasCapability('meter_distance') ? device.getCapabilityValue('meter_distance') : null,
      last_refresh: (device.lastRefresh ? new Date(device.lastRefresh).toISOString() : null)
        || (device.hasCapability('last_refresh') ? device.getCapabilityValue('last_refresh') : null),
      defrost: device.hasCapability('defrost') ? device.getCapabilityValue('defrost') : null,
      refresh_status: device.hasCapability('refresh_status') ? device.getCapabilityValue('refresh_status') : null,
      measure_odo: device.hasCapability('measure_odo') ? device.getCapabilityValue('measure_odo') : null,
      is_ev: !!device.isEV,
      default_image: defaultImage,
    };
  },

  async carAction({ homey, body }) {
    const driver = homey.drivers.getDriver('car');
    if (!driver) {
      throw new Error('Car driver not found');
    }

    const devices = driver.getDevices();
    let device;

    if (body && body.deviceId) {
      const targetId = String(body.deviceId).trim();
      device = devices.find((d) => {
        const data = (typeof d.getData === 'function' && d.getData()) || {};
        return String(d.id) === targetId || String(data.id) === targetId;
      });
    }

    if (!device && devices.length > 0) {
      device = devices[0];
    }

    if (!device) {
      throw new Error('Car device not found');
    }

    const { action, value } = body || {};

    switch (action) {
      case 'refresh':
        await device.refreshStatus(true, 'widget');
        break;
      case 'lock':
        await device.lock(Boolean(value), 'widget');
        break;
      case 'charge':
        await device.chargingOnOff(Boolean(value), 'widget');
        break;
      case 'climate':
        await device.acOnOff(Boolean(value), 'widget');
        break;
      case 'defrost':
        await device.defrostOnOff(Boolean(value), 'widget');
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    return { ok: true, action, value };
  },
};

