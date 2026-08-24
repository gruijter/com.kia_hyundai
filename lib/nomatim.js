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

const https = require('https');
const qs = require('querystring');
// const util = require('util');

const _makeHttpsRequest = (options = {}) => new Promise((resolve, reject) => {
  const opts = options;
  opts.timeout = options.timeout || 5000;
  const req = https.request(opts, (res) => {
    let resBody = '';
    res.on('data', (chunk) => {
      resBody += chunk;
    });
    res.once('end', () => {
      if (!res.complete) {
        return reject(Error('The connection was terminated while the message was still being sent'));
      }
      res.body = resBody;
      return resolve(res); // resolve the request
    });
  });
  req.on('error', (e) => {
    req.destroy();
    return reject(e);
  });
  req.on('timeout', () => {
    req.destroy();
  });
  req.end();
});

const search = async (params) => {
  try {
    const errTxt = 'Parameter needs to be a string or an object with street, city, county, state, country, postalcode';
    if (typeof params === 'object') {
      if (!Object.keys(params).some((key) => ['street', 'city', 'county', 'state', 'country', 'postalcode'].includes(key))) throw Error(errTxt);
    } else if (typeof params !== 'string') throw Error(errTxt);
    const query = {
      format: 'jsonv2', // [xml|json|jsonv2|geojson|geocodejson]
      addressdetails: 1,
      extratags: 1,
      namedetails: 1,
      limit: 1,
      email: 'gruijter@hotmail.com', // <valid email address> only used to contact you in the event of a problem, see Usage Policy
    };
    if (typeof params === 'string') query.q = params;
    if (typeof params === 'object') Object.assign(query, params);
    const headers = {
      'Content-Length': 0,
      'User-Agent': 'Homey Hyundai_Kia',
    };
    const options = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/search?${qs.stringify(query)}`,
      headers,
      method: 'GET',
    };
    const result = await _makeHttpsRequest(options, '');
    if (result.statusCode !== 200 || result.headers['content-type'] !== 'application/json; charset=UTF-8') {
      throw Error(`geo search service error: ${result.statusCode}`);
    }
    const jsonData = JSON.parse(result.body);
    if (jsonData.length < 1) throw Error('location not found');
    // console.log(util.inspect(jsonData, { depth: null, colors: true }));
    return Promise.resolve(jsonData[0]);
  } catch (error) {
    return Promise.reject(error);
  }
};

const reverseGeo = async (lat, lon) => {
  try {
    const query = {
      format: 'jsonv2', // [xml|json|jsonv2|geojson|geocodejson]
      // osm_type: 'N', // [N|W|R] node / way / relation, preferred over lat,lon
      lat, // The location to generate an address for
      lon, // The location to generate an address for
      zoom: 18, // [0-18] Level of detail required where 0 is country and 18 is house/building
      addressdetails: 1, // [0|1] Include a breakdown of the address into elements
      email: 'gruijter@hotmail.com', // <valid email address> only used to contact you in the event of a problem, see Usage Policy
      // extratags: 1, // [0|1] Include additional information in the result if available, e.g. wikipedia link, opening hours.
      // namedetails: 1, // [0|1] Include a list of alternative names in the results. language variants, references, operator and brand
    };
    const headers = {
      'Content-Length': 0,
      'User-Agent': 'Homey Hyundai_Kia',
    };
    const options = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/reverse?${qs.stringify(query)}`,
      headers,
      method: 'GET',
    };
    const result = await _makeHttpsRequest(options, '');
    if (result.statusCode !== 200 || !result.headers['content-type'].includes('json')) {
      throw Error(`reverse geo service error: ${result.statusCode}`);
    }
    const jsonData = JSON.parse(result.body);
    // console.log(util.inspect(jsonData, { depth: null, colors: true }));
    return Promise.resolve(jsonData);
  } catch (error) {
    return Promise.reject(error);
  }
};

const test = () => {
  const testLocs = [[51.50667, -0.08713], [52.46760, 13.52803], [41.88980, 12.49124], [38.89734, -77.03655]];
  const resArray = testLocs.map((loc) => reverseGeo(loc[0], loc[1]));
  const testAddress = 'Amsterdam nemo';
  resArray.push(search(testAddress));
  return Promise.all(resArray);
};

const getCarLocString = async (location) => {
  try {
    let local = '-?-';
    let address = '-?-';
    const loc = await reverseGeo(location.latitude, location.longitude);
    if (!loc.address) { // no reverse geolocation available
      return Promise.resolve({ location, address });
    }
    // const countryCode = loc.address.country_code.toUpperCase();
    local = loc.address.city_district || loc.address.village || loc.address.town || loc.address.city
      || loc.address.municipality || loc.address.county || loc.address.state_district || loc.address.state || loc.address.region;
    // locString = `${countryCode}${loc.address.postcode} ${local}`;
    // local = `${local}`;
    address = loc.display_name;
    return Promise.resolve({ local, address });
  } catch (error) {
    return Promise.reject(error);
  }
};

module.exports.test = test;
module.exports.search = search;
module.exports.reverseGeo = reverseGeo;
module.exports.getCarLocString = getCarLocString;
