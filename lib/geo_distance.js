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

const EARTH_RADIUS_KM = 6371.01;
const DEG2RAD = Math.PI / 180;

// Great-circle distance between two lat/lon points (spherical law of
// cosines), in kilometers. Replaces the 'geopoint' dependency, which was
// only ever used for this single calculation.
const distanceKm = (lat1, lon1, lat2, lon2) => {
  const radLat1 = lat1 * DEG2RAD;
  const radLat2 = lat2 * DEG2RAD;
  const radLonDelta = (lon2 - lon1) * DEG2RAD;
  const cosAngle = (Math.sin(radLat1) * Math.sin(radLat2))
    + (Math.cos(radLat1) * Math.cos(radLat2) * Math.cos(radLonDelta));
  // clamp against floating-point drift pushing cosAngle slightly outside
  // [-1, 1] for near-identical points, which would make acos() return NaN
  const clamped = Math.min(1, Math.max(-1, cosAngle));
  return Math.acos(clamped) * EARTH_RADIUS_KM;
};

module.exports = { distanceKm };
