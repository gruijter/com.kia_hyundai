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
