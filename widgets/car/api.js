'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The one directory a Homey app may write to (Homey Pro only — which is fine,
// widgets don't run on Homey Cloud at all). It survives app updates and is
// wiped only on uninstall. NOTE: it is also served publicly and unauthenticated
// at https://<homey>/app/com.kia/userdata/<file>, which is why uploads get a
// random UUID filename rather than something guessable like `car-1.jpg`.
const USERDATA_DIR = '/userdata';

// deviceId -> stored filename, so each car keeps its own picture.
const IMAGE_SETTINGS_KEY = 'widgetCarImages';

// Guard only: the widget downscales on a canvas before uploading, so anything
// near this means a client that skipped that step.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

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

// Keyed by filename, and every upload mints a fresh UUID, so a replaced image
// can never be served from a stale entry — no explicit invalidation needed
// beyond dropping the old key when its file is deleted.
const customImageCache = new Map();

async function getCustomCarImage(homey, deviceKey) {
  const stored = homey.settings.get(IMAGE_SETTINGS_KEY) || {};
  const filename = stored[deviceKey];
  if (!filename) return '';
  if (customImageCache.has(filename)) return customImageCache.get(filename);
  try {
    const buffer = await fs.promises.readFile(path.join(USERDATA_DIR, filename));
    const mime = Object.keys(ALLOWED_MIME)
      .find((m) => filename.endsWith(ALLOWED_MIME[m])) || 'image/jpeg';
    const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;
    customImageCache.set(filename, dataUri);
    return dataUri;
  } catch {
    // File vanished (manual delete, restore from a backup taken before the
    // upload). Fall through to the shipped image rather than erroring.
    return '';
  }
}

// getCarData()/carAction() both resolved the device by hand; upload/delete need
// the same lookup, so it lives here once. `id` comes from query or body.
function findDevice(homey, id) {
  const driver = homey.drivers.getDriver('car');
  if (!driver) return null;
  const devices = driver.getDevices();
  let device;
  if (id) {
    const targetId = String(id).trim();
    device = devices.find((d) => {
      const data = (typeof d.getData === 'function' && d.getData()) || {};
      return String(d.id) === targetId || String(data.id) === targetId;
    });
  }
  if (!device && devices.length > 0) [device] = devices;
  return device || null;
}

// The identity getCarData() already reports as `id`; images are keyed on it so
// the widget can ask for the right one without a second concept of identity.
const deviceKeyOf = (device) => String(
  (typeof device.getData === 'function' && device.getData()?.id) || device.id,
);

// Best-effort: a leftover file in /userdata is harmless, and failing an upload
// because the *previous* image couldn't be unlinked would be the wrong trade.
async function removeStoredImage(filename) {
  if (!filename) return;
  customImageCache.delete(filename);
  await fs.promises.unlink(path.join(USERDATA_DIR, filename)).catch(() => {});
}

module.exports = {
  async getCarData({ homey, query }) {
    const device = findDevice(homey, query && query.deviceId);
    if (!device) {
      return null;
    }

    const customImage = await getCustomCarImage(homey, deviceKeyOf(device));
    // The shipped default is ~193kB once base64-encoded and this response is
    // refetched every 30s, so only send it when it can actually be used: as
    // the image itself, or as the onerror fallback for a broken `imageUrl`
    // setting. An uploaded photo arrives as a data URI that cannot fail to
    // load, so alongside one the default would be pure waste on every poll.
    const defaultImage = customImage ? '' : await getDefaultCarImage();

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
      // `disableDoorWindowControl` device setting — the widget hides its
      // lock button on it. Refusing the action is device.js's job
      // (assertControlAllowed), this is only what the UI reads.
      control_disabled: !!device.getSettings().disableDoorWindowControl,
      default_image: defaultImage,
      custom_image: customImage,
    };
  },

  async carAction({ homey, body }) {
    const device = findDevice(homey, body && body.deviceId);
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

  // Store a user-supplied car picture. `dataUrl` is a base64 data URI already
  // downscaled by the widget (see uploadCarImage() in public/index.html) —
  // it is re-served to every widget refresh, so size is the widget's problem
  // to keep small and ours to refuse if it didn't.
  async uploadImage({ homey, body }) {
    const device = findDevice(homey, body && body.deviceId);
    if (!device) throw new Error('Car device not found');

    const match = /^data:([^;,]+);base64,(.+)$/.exec((body && body.dataUrl) || '');
    if (!match) throw new Error('Expected a base64 image data URI');
    const [, mime, b64] = match;
    const extension = ALLOWED_MIME[mime];
    if (!extension) throw new Error(`Unsupported image type: ${mime}`);

    const buffer = Buffer.from(b64, 'base64');
    if (!buffer.length) throw new Error('Image is empty');
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`Image is ${Math.round(buffer.length / 1024)}kB, max ${MAX_IMAGE_BYTES / 1024}kB`);
    }

    // Unguessable name: /userdata is served publicly without authentication.
    const filename = `car-${crypto.randomUUID()}${extension}`;
    await fs.promises.mkdir(USERDATA_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(USERDATA_DIR, filename), buffer);

    // Only record the new file once it is safely on disk, so a failed write
    // leaves the previous picture (or the shipped default) in place.
    const key = deviceKeyOf(device);
    const stored = homey.settings.get(IMAGE_SETTINGS_KEY) || {};
    const previous = stored[key];
    stored[key] = filename;
    homey.settings.set(IMAGE_SETTINGS_KEY, stored);
    await removeStoredImage(previous);

    return { ok: true, bytes: buffer.length };
  },

  // Drop the custom picture; the widget then falls back to the `imageUrl`
  // setting, and failing that to the shipped car image.
  async deleteImage({ homey, body }) {
    const device = findDevice(homey, body && body.deviceId);
    if (!device) throw new Error('Car device not found');

    const key = deviceKeyOf(device);
    const stored = homey.settings.get(IMAGE_SETTINGS_KEY) || {};
    const filename = stored[key];
    delete stored[key];
    homey.settings.set(IMAGE_SETTINGS_KEY, stored);
    await removeStoredImage(filename);

    return { ok: true };
  },
};
