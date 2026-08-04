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
