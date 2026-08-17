# lib/connect — maintenance guide

This folder is a JS port of the relevant parts of
[hyundai_kia_connect_api](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api)
(Python, actively maintained). Goal: when that project ships a fix for an API
change, it should be quick and low-risk to port that fix over here — without
having to understand the rest of this codebase.

## File mapping

| Python (upstream)              | JS (here)                                  |
|---------------------------------|---------------------------------------------|
| `const.py`                      | `native/const.js`                            |
| `utils.py`                      | `native/utils.js`                            |
| `exceptions.py`                 | `native/exceptions.js`                       |
| `ApiImpl.py` (`ApiImplSession`) | `native/http.js`                             |
| `ApiImpl.py` (interface)        | `native/ApiImpl.js`                          |
| `ApiImplType1.py`               | `native/ApiImplType1.js`                     |
| `KiaUvoApiEU.py`                | `native/regions/KiaUvoApiEU.js`              |
| `KiaUvoApiAU.py`                | `native/regions/KiaUvoApiAU.js`              |
| `KiaUvoApiCN.py`                | `native/regions/KiaUvoApiCN.js`              |
| `KiaUvoApiCA.py`                | `native/regions/KiaUvoApiCA.js`              |
| `KiaUvoApiUSA.py`               | `native/regions/KiaUvoApiUSA.js`             |
| `HyundaiBlueLinkApiUSA.py`      | `native/regions/HyundaiBlueLinkApiUSA.js`    |
| `VehicleManager.py`             | `native/VehicleManager.js`                   |
| `Token.py`                      | `native/Token.js`                            |
| *(no upstream equivalent)*      | `index.js`                                   |

When upstream adds/changes a region (e.g. `KiaUvoApiCA.py`), create or update
the corresponding file in `native/regions/` following the same naming.

## Naming convention

Every Python `snake_case` method/field has a `camelCase` counterpart with the
same meaning, so an upstream diff is directly recognizable:

| Python                          | JS                        |
|-----------------------------------|----------------------------|
| `login()`                        | `login()`                 |
| `get_vehicles()`                  | `getVehicles()`            |
| `update_vehicle_with_cached_state`| `updateVehicleWithCachedState` |
| `force_refresh_vehicle_state`     | `forceRefreshVehicleState`  |
| `lock_action(..., action)`        | `lockAction(..., action)`   |
| `start_climate(..., options)`     | `startClimate(..., options)`|
| `set_charge_limits(..., ac, dc)`  | `setChargeLimits(..., ac, dc)` |
| `_get_stamp` / `_get_device_id`   | `_getStamp` / `_getDeviceId` |
| `@_retry_on_device_id_error`      | `retryOnDeviceIdError(fn)` wrapper, applied in the constructor |

`options` objects (e.g. `ClimateRequestOptions`) aren't a dataclass but a
plain object with the same camelCase fields (`setTemp`, `defrost`, `heating`,
`steeringWheel`, ...).

## Main structural deviation from upstream

Upstream's `update_vehicle_with_cached_state` / `_update_vehicle_properties(_ccs2)`
mutate a `Vehicle` dataclass with ~1000 lines of field-by-field parsing.
Homey's `drivers/car/device.js#mapStatus()` already reads the raw cloud JSON
itself (the same paths the Python parsing uses, e.g.
`Cabin.HVAC.Row1.Driver.Temperature.Value`). That's why
`updateVehicleWithCachedState` and `forceRefreshVehicleState` here **return
the raw JSON** instead of mutating an object. This is the only deliberate
structural deviation — everything else (URLs, headers, stamp/device-id
logic, error handling, retry behavior) is a direct port.

`_get_driving_info` (the `drvhistory` endpoint) was ported as
`VehicleManager#drivingInfo(vehicleConfig)` — kept raw (not parsed into
`DailyDrivingStats`), only used for the debug dump so far (see
`zzz_responses/README.md`), not wired to any Homey capability yet.

Still not carried over (no Homey use case yet): `update_month_trip_info`/
`update_day_trip_info` (`tripinfo` endpoint — distinct from `drvhistory`,
per-trip records rather than daily energy totals), `schedule_charging_and_climate`.
Port these once there's a concrete Homey feature that needs them.

## No bluelinky-shaped layer — call VehicleManager directly

The `bluelinky` dependency has been fully removed (no fallback left — all
regions from `driver.settings.compose.json` are natively ported), and so has
the adapter layer that used to translate this API into bluelinky's shape
(`native/Vehicle.js`, and `index.js#createClient()`'s `EventEmitter`/
`'ready'`/`'error'` constructor). `drivers/car/driver.js` and `device.js` now
call `VehicleManager` methods directly, the same way `VehicleManager.py` is
used upstream and the same way `scripts/test-eu-connect.js` already did:

- `index.js#createClient(options)` maps Homey-side option names (`region:
  'EU'`, `brand: 'kia'`) to the Python project's region/brand enums and
  returns a plain `VehicleManager` instance — no events, no wrapper.
- `await manager.login()` returns a plain array of `vehicleConfig` objects
  (not wrapped instances). Every other call takes `vehicleConfig` as an
  explicit first argument, e.g. `manager.lock(vehicleConfig)`,
  `manager.startClimate(vehicleConfig, options)`.
- `device.js#runCommand(command, args)` is the one place that dispatches
  Homey's internal queue-command names (`'start'`, `'lock'`,
  `'flashLights'`, ...) to the matching `VehicleManager` call — this is
  Homey-app-specific command routing, not an API-shape translation.

Two name/shape differences survive from the old bluelinky-shaped device.js
call sites and are worth knowing when reading `device.js`:

- `setChargeTargets({fast, slow})` (device.js) → upstream `set_charge_limits(ac, dc)`:
  `fast` = DC (rapid charging), `slow` = AC (Type 2) → `setChargeLimits(vehicleConfig, slow, fast)`.
- `device.js`'s climate control methods (`acOnOff`, `defrostOnOff`,
  `setTargetTemp`) build args directly in upstream's `ClimateRequestOptions`
  shape (`setTemp`, `defrost`, `heating`, `steeringWheel`) — no translation
  layer needed anymore, this *is* the shape passed to `startClimate()`.

## Logging (important for non-EU debugging)

There are no test accounts for AU/CN/CA/US — validating/debugging has to
happen via Homey's own log viewer and diagnostic reports (sent manually or
automatically by users). Because of this, two layers log automatically,
always redacted (never passwords/PINs/tokens/OTP codes, see
`native/logger.js`):

- **`native/http.js#ApiImplSession`**: every HTTP request/response, prefixed
  with the region class (e.g. `[KiaUvoApiCA] → POST /tods/api/v2/login`
  followed by `← 200 ... <redacted, truncated body>`). This **always** logs
  the body, not just on an HTTP error status — many of these APIs encode
  errors in a 200-OK JSON body (`retCode`/`resCode`/`responseHeader.
  responseCode`), not via the HTTP status.
- **`native/VehicleManager.js`**: per-device milestones (`login: start/OK/
  FAILED`, each command like `lockAction: start/OK/FAILED`), prefixed with
  `[VehicleManager:<region>:<brand>]`.

`createClient({ ..., logger })` passes the logger down from `driver.js`/
`device.js` (`{ log: this.log.bind(this), error: this.error.bind(this) }`),
so all of this ends up in Homey's normal device log. New regions don't need
to do anything extra for this — just pass `logger` through to
`ApiImplSession` (see any existing region file as an example) and the HTTP
layer logs automatically.

## Validation status per region

Besides the live EU test below, all regions have also been tested with a
mock script (fake credentials against the **real** production servers —
safe, since a wrong password just fails with an auth error). That confirms
the request shape (URL, headers, body, TLS, compression, cookies) elicits a
valid response from the server, even though there's no account to get
further than login.

| Region | Status | Known risks |
|-------|--------|-------------------|
| EU (Kia + Hyundai) | **Live validated** (real Kia Niro HEV/PHEV + Niro EV, 2026-08-04; OneApp/CCI login re-validated 2026-08-17 via `homey app run --remote` against real accounts on both branches — Kia: 1 device, 4 vehicles found; Hyundai (`com.hyundai` branch): 2 devices, 2 vehicles each — all logins OK, full flow incl. CCI token exchange + CCS re-exchange, status fetched, no errors). Password login was ported to the OneApp/CCI flow that day (upstream #1273/#1277-#1279, WAF block on the old IDPConnect authorize endpoint). `_refreshCciToken` (token refresh, ~24h CCS TTL) is ported faithfully but not yet observed live — neither session ran long enough to hit a refresh. | `KiaUvoApiEU.js#_loginWithPasswordCci` step 1 (authorize call) can miss Set-Cookie headers on intermediate redirect hops — Node's `fetch` with `redirect:'follow'` only returns the headers of the final response, Python's `requests.Session` accumulates across all hops. Hasn't proven to be a problem in the live test yet, but is the first checkpoint for a login issue. |
| AU (Kia + Hyundai + Kia NZ) | Mock-tested against the live server (2026-08-04): reaches the server, gets a correct `401 Require authentication` on fake credentials — request shape works | Simpler login flow than EU (no RSA), otherwise 1:1 with EU's Type1 base. Raw status shape normalized from upstream's `status.*` to `vehicleStatus.*`. Status/control after login untested. |
| CN (Kia + Hyundai) | Mock-tested against the live server (2026-08-04): **fails already on the very first call** (`notifications/register` → `4002 Invalid parameter`), before credentials are even sent | Payload/headers were checked 1:1 against the Python source and are correct — the cause is unknown (possibly a server-side change, or a pre-existing issue in the Python source itself, which also gets little testing on this endpoint). **First thing to investigate once a CN account is available.** Login also does two sequential OAuth calls (see code comment); `refreshToken` is literally stored as `"<type> <access_token>"` — not a typo, upstream does it the same way. |
| CA (Kia + Hyundai) | Mock-tested against the live server (2026-08-04): reaches the server, gets a correct "incorrect login" error on fake credentials — request shape works | **OTP not wired up to a pairing UI** — `sendOtp`/`verifyOtpAndCompleteLogin` exist on `VehicleManager`, but `driver.js` has no step that calls them. For an account that requires OTP, pairing fails with a clear `AuthenticationOTPRequired` error instead of a crash. Device id uses a hand-written UUID5 (Node has no built-in one). Status/control after login untested. |
| US — Kia | Mock-tested against the live server (2026-08-04): reaches the server, gets a correct "Invalid Email or Password" error on fake credentials — request shape works (incl. the TLS cipher workaround and gzip decompression, see below) | Completely different backend (`api.owners.kia.com`, session-header auth instead of OAuth) with a very different raw status shape — translated here to the common `vehicleStatus.*` shape, but **only for the fields `mapStatus()` uses**, not 1:1 with upstream's full parsing (so status/control after login is untested). OTP on an unrecognized device isn't wired up to a pairing UI (same limitation as CA). |
| US — Hyundai | Mock-tested against the live server (2026-08-04): reaches the server, gets a correct "Incorrect username or password" error on fake credentials — request shape works | Different backend than Kia USA (`api.telematics.hyundaiusa.com`), but the raw status shape is already nearly identical to the EU convention — barely any normalization needed. Status/control after login untested. |

Two real bugs were already found and fixed in `native/http.js` thanks to the
mock test against the live servers (both affected the US regions, the only
ones that use the `httpsAgent` branch instead of `fetch` for the TLS cipher
workaround):
1. **Set-Cookie wasn't handled correctly** — Node's `https` module always
   returns `set-cookie` as an array (even for 1 cookie), but the cookie jar
   expected a string. Fixed by also implementing a `getSetCookie()` on the
   `https.Agent` path, just like fetch's `Headers`.
2. **Gzip/br responses weren't decompressed** — unlike `fetch`, Node's
   `https` module doesn't decompress the body automatically. Kia USA's
   server compressed its 200-OK response, which without this fix arrived as
   unreadable bytes at `JSON.parse()`. Fixed with `zlib` based on the
   `content-encoding` header.

For the non-EU regions in general: login/status/control was ported as
faithfully as possible from the Python source, but without a test account
this hasn't been verified with a real account (only the request shape, up to
the login attempt). Treat errors here as a first sign that an endpoint,
header, or field name changed or was ported incorrectly — compare against
the corresponding Python file before devising a fix, and use the logging
described above to see where it goes wrong.
