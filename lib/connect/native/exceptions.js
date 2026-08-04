/* eslint-disable max-classes-per-file */

'use strict';

// Port of exceptions.py. Keep the class hierarchy the same as upstream so
// error handling in device.js based on `instanceof` keeps working when
// upstream adds new exception types.

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
