/* eslint-disable max-classes-per-file */

'use strict';

// Poort van exceptions.py. Houd de klassenhiërarchie hetzelfde als upstream
// zodat foutafhandeling in device.js op basis van `instanceof` kan blijven werken
// wanneer upstream nieuwe exception-types toevoegt.

class HyundaiKiaException extends Error {}

class AuthenticationError extends HyundaiKiaException {}
class AuthenticationOTPRequired extends AuthenticationError {}
class ConsentRequiredError extends AuthenticationError {}

class APIError extends HyundaiKiaException {}
class DeviceIDError extends APIError {}
class RateLimitingError extends APIError {}
class NoDataFound extends APIError {}
class ServiceTemporaryUnavailable extends APIError {}
class DuplicateRequestError extends APIError {}
class UnsupportedControlError extends APIError {}
class RequestTimeoutError extends APIError {}
class InvalidAPIResponseError extends APIError {}

module.exports = {
  HyundaiKiaException,
  AuthenticationError,
  AuthenticationOTPRequired,
  ConsentRequiredError,
  APIError,
  DeviceIDError,
  RateLimitingError,
  NoDataFound,
  ServiceTemporaryUnavailable,
  DuplicateRequestError,
  UnsupportedControlError,
  RequestTimeoutError,
  InvalidAPIResponseError,
};
