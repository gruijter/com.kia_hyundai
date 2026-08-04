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

## Bekend risicopunt (nog live te valideren)

`KiaUvoApiEU.js#_loginWithPassword` stap 1 (authorize-call) kan Set-Cookie
headers op tussenliggende redirect-hops missen — Node's `fetch` met
`redirect:'follow'` geeft alleen de headers van de uiteindelijke response
terug, terwijl Python's `requests.Session` cookies over alle hops heen
accumuleert. Zie de code-comment op die plek. Eerste checkpunt als login
faalt tijdens de EU-validatie (Fase 2 van het plan).
