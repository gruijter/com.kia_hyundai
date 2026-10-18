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
| `cci_fingerprint.py`            | `native/cciFingerprint.js`                   |
| `KiaUvoApiEU.py`                | `native/regions/KiaUvoApiEU.js`              |
| `KiaUvoApiAU.py`                | `native/regions/KiaUvoApiAU.js`              |
| `KiaUvoApiCN.py`                | `native/regions/KiaUvoApiCN.js`              |
| `KiaUvoApiCA.py`                | `native/regions/KiaUvoApiCA.js`              |
| `KiaUvoApiUSA.py`               | `native/regions/KiaUvoApiUSA.js`             |
| `HyundaiBlueLinkApiUSA.py`      | `native/regions/HyundaiBlueLinkApiUSA.js`    |
| `KiaUvoApiIN.py`                | `native/regions/KiaUvoApiIN.js`              |
| `HyundaiBlueLinkApiBR.py`       | `native/regions/HyundaiBlueLinkApiBR.js`     |
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
logic, error handling, retry behavior) is a direct port. A consequence: an
upstream fix to `_update_vehicle_properties*` lands in `mapStatus()` (and in
`driver.js#extractCheckableStatus()`, which reads the same fields at pairing).

There is no `Vehicle` object either, so upstream logic that fills options from
the vehicle's parsed state has no counterpart here; `device.js` builds complete
options itself (e.g. `buildScheduleOptions()` echoes back the raw reservation
for `scheduleChargingAndClimate`).

`_get_driving_info` (`drvhistory`) and `update_month_trip_info` /
`update_day_trip_info` (`tripinfo`) are ported raw, as
`VehicleManager#drivingInfo(vehicleConfig)` and
`VehicleManager#tripInfo(vehicleConfig, dateString, period)`
(`period: 'month'|'day'`). `drivingInfo` only feeds the debug dump (see
`zzz_responses/README.md`); `tripInfo` has no caller.

## The status shape every region must return

`device.js#mapStatus()` reads one shape, whatever the region:

```
{ vehicleStatus: { time, ... }, vehicleLocation: { coord, speed, time }, odometer: { value, unit } }
```

for legacy (non-CCS2) cars, or the bare CCS2 `Vehicle` object (recognised by
its `Date` key) for CCS2 cars. Details that are load-bearing and easy to miss
when porting a region, because upstream has no equivalent constraint — it
parses each region's own field names into a `Vehicle` dataclass instead:

- **`vehicleStatus.time` gates the entire legacy branch.** No `time`, nothing
  maps at all — not the lock state, battery, climate, range or alarms.
  Upstream's own per-region timestamp field is `time` on EU/AU/CN/IN, but
  `lastStatusDate` on CA and `dateTime` on Hyundai USA, so those two regions
  must alias it.
- **`odometer` sits next to `vehicleStatus`, not inside it.** EU's
  `resMsg.vehicleStatusInfo` delivers it there already; AU/NZ/CN carry it
  *inside* their status and must hoist it; CA takes it from the separate
  `nxtsvc` call and IN from `setting/alert/maintenance`, exactly as upstream's
  `_update_vehicle_properties_service` / `_update_vehicle_maintenance_alert`
  do. EU's forced (non-CCS2) `/status` returns only the `vehicleStatus` block,
  so `device.js#doPoll()` reads the odometer via `odometer()` after a forced
  refresh.
- **EU location timestamps are on two clocks.** `/location` `time` is UTC;
  `/location/park` and the cached `vehicleLocation.time` are region-local, like
  `vehicleStatus.time` (upstream #1292 documents the same). Never compare a
  `/location` time with any of the others as strings.

Each region does the shaping in one place (`_normalizeStatus`, or
`_buildStatus` on Hyundai USA). There is no test account for any non-EU region,
so a status shape regression is silent — it just yields a device with no data.
When adding or reworking a region, check the shape against a real response (or
upstream's `tests/fixtures`) before anything else.

## Calling the API

`drivers/car/driver.js` and `device.js` call `VehicleManager` methods directly,
the same way `VehicleManager.py` is used upstream (and `zzz_test/test-eu-connect.js`):

- `index.js#createClient(options)` maps Homey-side option names (`region:
  'EU'`, `brand: 'kia'`) to the Python project's region/brand enums and
  returns a plain `VehicleManager` instance.
- `await manager.login()` returns a plain array of `vehicleConfig` objects.
  Every other call takes `vehicleConfig` as an explicit first argument, e.g.
  `manager.lock(vehicleConfig)`, `manager.startClimate(vehicleConfig, options)`.
- `device.js#runCommand(command, args)` is the one place that dispatches
  Homey's internal queue-command names (`'start'`, `'lock'`,
  `'flashLights'`, ...) to the matching `VehicleManager` call.
- `setChargeTargets({fast, slow})` (device.js) → upstream `set_charge_limits(ac, dc)`:
  `fast` = DC (rapid charging), `slow` = AC (Type 2) → `setChargeLimits(vehicleConfig, slow, fast)`.
- `device.js`'s climate methods (`acOnOff`, `defrostOnOff`, `setTargetTemp`)
  build args directly in upstream's `ClimateRequestOptions` shape (`setTemp`,
  `defrost`, `heating`, `steeringWheel`), passed as-is to `startClimate()`.
- `VehicleManager` never persists a `Token`: every one comes from `login()`
  with the manager's own credentials, and a settings change restarts the
  device with a new manager.

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

## Which regions a brand may pick

`index.js#regionsForBrand(brand)` is the single source of truth for the region
picker in `drivers/car/pair/pair.html` and `repair.html` — both ask the driver
for it (`session.setHandler('regions', ...)` in `drivers/car/driver.js`) rather
than hardcoding a list, because the two published apps do not support the same
set: **Brazil is Hyundai only** and **New Zealand is Kia only** (no backend for
the other brand; the dispatcher rejects it explicitly).

The `region` dropdown on the device settings page still lists every region for
both brands — it is static per-app JSON and the advanced/repair path, so a
wrong combination there fails at login with that same explicit error rather
than being prevented up front.

## Upstream sync point

Last compared against upstream **master** (commit `e7cc04a`, after v4.36.1). Deliberately not
ported, with the reason, so the next diff doesn't re-open them:

| Upstream | Why not |
|---|---|
| #1203 / #1310 / #1314 SVM / Find My Car camera images | New feature, not a fix. Only Hyundai BlueLink USA and the unported EU CCI region implement it. Would need a new Homey image/flow surface and a live Hyundai USA car with SVM to validate. |
| #1284 / #1305 `GspaApiEU` / `HyundaiCciApiEU` / `KiaCciApiEU`, `REGION_EUROPE_CCI` | A *parallel* EU region, not a replacement — `REGION_EUROPE` still dispatches to `KiaUvoApiEU` for every brand upstream. Needs the ~250 KB per-brand `gspa/*_cipher_params.json` blobs. Revisit once upstream has live fixtures. |
| #1292 (EU `/location` time is UTC) | No location timestamp is exposed here; the finding itself is relied on — see the status shape section. |
| #1293 (CCS2 `BatteryPreCondition.Status`) | No battery-precondition capability exists in the app; nothing reads that field. |
| #1303 "None = leave unchanged" schedule options | Only its `[9]` "no days selected" default is ported. The fill-from-vehicle logic needs a `Vehicle` object (see the structural deviation above), so the EV5 per-scope endpoint skip never applies: both scopes are always sent, and #1328's sequencing always runs. Its temperature guard isn't needed: the CCS2 status carries `Green.Reservation.Departure.Climate.Temperature`, which `buildScheduleOptions()` reads. |
| b1fdd79 (retry login when a refresh-token `token.password` fails) | Only fires for a token persisted across a credentials change; this port never persists tokens. |
| #1329 / #1330 GSPA OTA and CCI stored-status fields | Only touch `GspaApiEU` / `KiaCciApiEU`, which aren't ported (see #1284 above). |
| #1335 Type1 consolidation of AU/CN/IN into `ApiImplType1` | Pure refactor, no behaviour change. The JS region files keep their own copies; port it only if a later upstream diff no longer lines up. |
| #1325 CA typed errors for unexpected shapes | Already covered: `KiaUvoApiCA._checkResponseForErrors` rejects a missing `responseHeader`/`error` with `InvalidAPIResponseError`/`APIError`. |
| #1350 Genesis Australia auth | Neither app supports Genesis. |
| #1373 Kia USA `check_action_status` returns `ORDER_STATUS` | The USA port has no `checkActionStatus`, and nothing calls it for USA. |
| #1378 Hyundai USA per-tire pressures | New feature; the app only exposes `alarm_tire_pressure`. |
| #1359–#1376 signature/annotation/`otp_handler` refactors | No behaviour change in the port (USA `login` already takes `username, password, pin`). |

## Validation status per region

EU is live-validated. All other regions have been tested with a mock script
(fake credentials against the **real** production servers — safe, since a
wrong password just fails with an auth error). That confirms the request shape
(URL, headers, body, TLS, compression, cookies) gets a valid response, but
nothing past login: **status and control are untested outside EU.**

| Region | Status | Known risks |
|-------|--------|-------------------|
| EU (Kia + Hyundai) | **Live validated** on real Kia Niro HEV/PHEV/EV and Hyundai accounts, including the OneApp/CCI password login and CCS token exchange. | `_refreshCciToken` (~24h CCS TTL) is ported faithfully but not observed live. `_loginWithPasswordCci` step 1 (authorize) can miss Set-Cookie headers on intermediate redirect hops — Node's `fetch` with `redirect:'follow'` only returns the final response's headers, Python's `requests.Session` accumulates them. First checkpoint for a login issue. |
| AU (Kia + Hyundai) / NZ (Kia) | Mock-tested: device registration succeeds and `/user/signin` answers `401 4010` on fake credentials. | Simpler login than EU (no RSA), otherwise 1:1 with the Type1 base. Status normalized from upstream's `status.*` to `vehicleStatus.*`. Both use `Australia/Sydney` as data timezone, as upstream does. |
| IN (Kia + Hyundai) | Mock-tested: device registration succeeds, authorize page loads, `/user/signin` answers `401 4010`. | Classic Type1 login, no RSA, no OTP. Two upstream oddities ported verbatim: access and refresh tokens come from two separate `oauth2/token` calls, and the second stores its *access* token as the refresh token. `_ccs2State()` deviates on purpose — upstream feeds the raw `/ccs2/` `resMsg` to a legacy-only parser, so its CCS2 path can't work as written; here `resMsg.state.Vehicle` is unwrapped like every other region, with a fallback. |
| BR (Hyundai only) | Mock-tested: authorize page loads, `/user/signin` answers `401 4010` as a readable `AuthenticationError`. | Cached status is CCS2-shaped although BR vehicles report `ccuCCS2ProtocolSupport: 0`; `/status/latest` is the command-result feed there (always 503) and is never used. Force refresh is asynchronous (wake, wait 25s, re-read `/latest`) and refuses data whose `lastUpdateTime` didn't advance. Every command needs the PIN control token, so a PIN-less pairing can't control the car. No valet mode; windows move all together. Deviations: Type1's `USER_API_URL`/`SPA_API_URL*` are set (upstream leaves them undefined, so inherited methods raise), and `_getControlToken` is aliased to BR's `_ensureControlToken` so inherited commands use BR's PIN flow instead of EU's. |
| CN (Kia + Hyundai) | Mock-tested: reaches `loginInit.do` and `oauth2/authorize` (200) and gets `401 4010` from `/user/signin`. | Upstream's port (#1295) was verified end-to-end only by its author, on Hyundai; the Kia constants come from the same app binary. Login runs through the UARS service (`uars-{k|h}.hmgmobility.com.cn`), which returns the token bundle embedded in an HTML page — `extractUarsLoginBundle()` is the only HTML scraping in this port and the first suspect if login breaks. Device registration happens *after* signin, so the mock test doesn't exercise it. Tokens live 6h and refresh via `/user/silentsignin`. Everything marked `CN-UNVERIFIED` is marked the same upstream: PIN/control token, legacy force refresh, CCS2, `setChargeLimits`. |
| CA (Kia + Hyundai) | Mock-tested: correct "incorrect login" error on fake credentials. | OTP (untested live): `login()` throws `AuthenticationOTPRequired` with upstream's `OTPRequest` on `.otpRequest` instead of returning it; pair/repair views then run `sendOtp`/`verifyOtpAndCompleteLogin`. The device id is persisted in the device store (`deviceAuth`) and restored via `restoreDeviceAuth()` — upstream persists it inside the Token. Device id uses a hand-written UUID5. The location gate (#1294/#1296) keeps the last position in memory per vehicle (`_locationState`), standing in for upstream's `vehicle.location` / `vehicle._location_fetch_attempted` — without it every poll would spend a `vrfypin` + `fndmcr` pair. |
| US — Kia | Mock-tested: correct "Invalid Email or Password" error on fake credentials. | Different backend (`api.owners.kia.com`, session-header auth) with a very different raw status shape, translated to `vehicleStatus.*` **only for the fields `mapStatus()` uses**, not 1:1 with upstream. OTP as CA; `deviceAuth` also holds the `rmtoken`, sent on every login so OTP is only asked again when Kia expires it (`rmTokenExpired`). |
| US — Hyundai | Mock-tested: correct "Incorrect username or password" error on fake credentials. | Different backend than Kia USA (`api.telematics.hyundaiusa.com`); its raw status is already close to the EU shape. |

The two US regions go through `native/http.js`'s `https.Agent` branch (for a
TLS cipher workaround) instead of `fetch`, so that branch does what `fetch`
does for free: it collects `set-cookie` as an array (`getSetCookie()`) and
decompresses gzip/br bodies based on `content-encoding`. Keep both when
touching it.

For the non-EU regions in general: treat an error as a first sign that an
endpoint, header, or field name changed or was ported incorrectly — compare
against the corresponding Python file before devising a fix, and use the
logging described above to see where it goes wrong.
