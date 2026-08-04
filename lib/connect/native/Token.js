'use strict';

// Poort van Token.py. controlToken/controlTokenExpiry cachen het PIN-geverifieerde
// besturingstoken (nodig voor lock/climate/charge-commando's), zodat niet voor
// elk commando opnieuw de PIN-flow hoeft te worden doorlopen.
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
