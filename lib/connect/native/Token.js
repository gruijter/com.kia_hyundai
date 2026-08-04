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

// Port of Token.py. controlToken/controlTokenExpiry cache the PIN-verified
// control token (needed for lock/climate/charge commands), so the PIN flow
// doesn't have to be repeated for every command.
class Token {
  constructor({
    username, password, pin, accessToken, refreshToken, deviceId, validUntil,
  } = {}) {
    this.username = username;
    this.password = password;
    this.pin = pin;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.deviceId = deviceId;
    this.validUntil = validUntil || new Date(0);
    this.controlToken = null;
    this.controlTokenExpiry = 0;
  }
}

module.exports = Token;
