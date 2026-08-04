# lib/connect — onderhoudsgids

Deze map is een JS-poort van de relevante delen van
[hyundai_kia_connect_api](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api)
(Python, actief onderhouden). Doel: als dat project een fix doorvoert voor een
API-wijziging, moet die fix snel en met weinig risico hierheen over te zetten
zijn — zonder de rest van deze codebase te hoeven begrijpen.

## Bestandsmapping

| Python (upstream)              | JS (hier)                                  |
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
| *(geen upstream equivalent)*    | `native/Vehicle.js`, `index.js`              |

Wanneer upstream een regio toevoegt/wijzigt (bv. `KiaUvoApiCA.py`), maak of
werk je het bijbehorende bestand in `native/regions/` bij volgens dezelfde
naamgeving.

## Naamgevingsconventie

Elke Python `snake_case`-methode/veld heeft een `camelCase`-tegenhanger met
dezelfde betekenis, zodat een upstream-diff direct te herkennen is:

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
| `@_retry_on_device_id_error`      | `retryOnDeviceIdError(fn)` wrapper, toegepast in de constructor |

`options`-objecten (bv. `ClimateRequestOptions`) zijn geen dataclass maar een
gewoon object met dezelfde camelCase-velden (`setTemp`, `defrost`, `heating`,
`steeringWheel`, ...).

## Belangrijkste structurele afwijking van upstream

Upstream's `update_vehicle_with_cached_state` / `_update_vehicle_properties(_ccs2)`
muteren een `Vehicle`-dataclass met ~1000 regels veld-voor-veld parsing. Homey's
`drivers/car/device.js#mapStatus()` leest de raw cloud-JSON al zelf (dezelfde
paden als de Python-parsing gebruikt, bv. `Cabin.HVAC.Row1.Driver.Temperature.Value`).
Daarom geven `updateVehicleWithCachedState` en `forceRefreshVehicleState` hier
**de raw JSON terug** in plaats van een object te muteren. Dit is de enige
bewuste structurele afwijking — de rest (URLs, headers, stamp/device-id-logica,
foutafhandeling, retry-gedrag) is een directe poort.

Ook bewust niet overgenomen (geen Homey-gebruik): `_update_vehicle_drive_info`
(driving-info parsing), `update_month_trip_info`/`update_day_trip_info`,
`schedule_charging_and_climate`. Poort deze pas als er een concrete Homey-
functie voor komt.

## Bluelinky-compatibiliteitslaag

`native/Vehicle.js` en `index.js#createClient()` vertalen de interne API naar
dezelfde vorm als bluelinky (`status()`, `fullStatus()`, `location()`,
`odometer()`, `start()`, `stop()`, `lock()`, `unlock()`, `startCharge()`,
`stopCharge()`, `setChargeTargets({fast, slow})`, `setNavigation(poiList)`,
events `'ready'`/`'error'`). Let op twee naam/vorm-vertalingen die device.js
ongewijzigd laten werken maar die niet vanzelfsprekend zijn bij het lezen van
upstream:

- `setChargeTargets({fast, slow})` → upstream `set_charge_limits(ac, dc)`:
  `fast` = DC (snelladen), `slow` = AC (Type 2) → `setChargeLimits(vehicleConfig, slow, fast)`.
- `start(args)` climate-argumenten (bluelinky-vorm, uit device.js) → upstream
  `ClimateRequestOptions`: `temperature`→`setTemp`, `heating1`→`heating`,
  `steerWheelHeat`→`steeringWheel`, `igniOnDuration`→`duration`.

## Validatiestatus per regio

| Regio | Status | Bekende risico's |
|-------|--------|-------------------|
| EU (Kia + Hyundai) | **Live gevalideerd** (echte Kia Niro HEV/PHEV + Niro EV, 2026-08-04) | `KiaUvoApiEU.js#_loginWithPassword` stap 1 (authorize-call) kan Set-Cookie headers op tussenliggende redirect-hops missen — Node's `fetch` met `redirect:'follow'` geeft alleen de headers van de uiteindelijke response terug, Python's `requests.Session` accumuleert over alle hops. Nog niet fout gebleken in de live test, maar wel het eerste checkpunt bij een login-probleem. |
| AU (Kia + Hyundai + Kia NZ) | Blind geport, niet getest | Simpelere login-flow dan EU (geen RSA), verder 1-op-1 met EU's Type1-basis. Raw statusvorm genormaliseerd van upstream's `status.*` naar `vehicleStatus.*`. |
| CN (Kia + Hyundai) | Blind geport, niet getest | Login doet twee sequentiële OAuth-calls (zie code-comment); `refreshToken` wordt letterlijk als `"<type> <access_token>"` opgeslagen — geen typfout, zo doet upstream het ook. |
| CA (Kia + Hyundai) | Blind geport, niet getest | **OTP niet aangesloten op een pairing-UI** — `sendOtp`/`verifyOtpAndCompleteLogin` bestaan op `VehicleManager`, maar `driver.js` heeft geen stap die ze aanroept. Bij een account dat OTP vereist, faalt pairing met een duidelijke `AuthenticationOTPRequired`-foutmelding i.p.v. een crash. Device-id gebruikt een handgeschreven UUID5 (Node heeft er geen ingebouwde). |
| US — Kia | Blind geport, niet getest | Compleet andere backend (`api.owners.kia.com`, sessie-header-auth i.p.v. OAuth) met een sterk afwijkende raw statusvorm — hier vertaald naar de gangbare `vehicleStatus.*`-vorm, maar **alleen voor de velden die `mapStatus()` gebruikt**, niet 1-op-1 met upstream's volledige parsing. Vereist net als upstream een verlaagd TLS-securityniveau (`SECLEVEL=1`) — geport via Node's `https.Agent` (zie `native/http.js#httpsAgent`), zelf niet tegen een echte server geverifieerd. OTP bij een onbekend apparaat is niet aangesloten op een pairing-UI (zelfde beperking als CA). |
| US — Hyundai | Blind geport, niet getest | Andere backend dan Kia USA (`api.telematics.hyundaiusa.com`), maar raw statusvorm is wél al vrijwel identiek aan de EU-conventie — nauwelijks normalisatie nodig. Zelfde TLS-cipher-vereiste en -aanpak als Kia USA. |

Voor de niet-EU-regio's geldt: login/status/besturing is zo getrouw mogelijk
geport uit de Python-bron, maar zonder testaccount is dit niet live
geverifieerd. Behandel fouten hier als eerste aanwijzing dat een endpoint,
header of veldnaam is gewijzigd of verkeerd overgezet — vergelijk met het
bijbehorende Python-bestand voordat je een fix bedenkt.
