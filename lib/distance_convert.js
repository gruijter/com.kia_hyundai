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

/* eslint-disable strict */

// Kia/Hyundai's status API tags distance-type values with a unit code:
// 1 = km, 2/3 = mi, 0/undefined = unset (treated as km). Legacy (non-CCS2)
// exposes it per-field as {"value": X, "unit": N} on odometer/range; CCS2
// only exposes it on Drivetrain.FuelSystem.DTE.Unit — odometer itself has
// no per-field unit on CCS2, so device.js#mapStatus applies the single
// detected unit across all three distance capabilities either way.
const KM_TO_MI = 0.621371;

exports.isImperialUnit = (unitCode) => unitCode === 2 || unitCode === 3;

exports.kmToMi = (km) => (typeof km === 'number' ? km * KM_TO_MI : km);

exports.miToKm = (mi) => (typeof mi === 'number' ? mi / KM_TO_MI : mi);
