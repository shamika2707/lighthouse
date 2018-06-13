/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview Fills most of the role of NetworkManager and NetworkRequest classes from DevTools.
 * @see https://cs.chromium.org/chromium/src/third_party/blink/renderer/devtools/front_end/sdk/NetworkRequest.js
 * @see https://cs.chromium.org/chromium/src/third_party/blink/renderer/devtools/front_end/sdk/NetworkManager.js
 */

const URL = require('./url-shim');
const resourceTypes = require('../../third-party/devtools/ResourceType').TYPES;

module.exports = class NetworkRequest {
  constructor() {
    this.requestId = '';
    this._requestId = '';
    this.connectionId = '';
    this.connectionReused = false;

    this.url = '';
    this._url = '';
    this.protocol = '';
    this.parsedURL = /** @type {LH.WebInspector.ParsedURL} */ ({scheme: ''});

    this.startTime = -1;
    /** @type {number} */
    this.endTime = -1;
    /** @type {number} */
    this._responseReceivedTime = -1;

    this.transferSize = 0;
    this._resourceSize = 0;
    this._fromDiskCache = false;
    this._fromMemoryCache = false;

    this.finished = false;
    this.requestMethod = '';
    this.statusCode = -1;
    this.redirectSource = /** @type {NetworkRequest|undefined} */ (undefined);
    this.redirectDestination = /** @type {NetworkRequest|undefined} */ (undefined);
    this.redirects = /** @type {NetworkRequest[]|undefined} */ (undefined);
    this.failed = false;
    this.localizedFailDescription = '';

    this._initiator = /** @type {LH.Crdp.Network.Initiator} */ ({type: 'other'});
    this._timing = /** @type {LH.Crdp.Network.ResourceTiming|undefined} */ (undefined);
    this._resourceType = /** @type {LH.WebInspector.ResourceType|undefined} */ (undefined);
    this._mimeType = '';
    this.priority = () => /** @type {LH.Crdp.Network.ResourcePriority} */ ('Low');
    this.initiatorRequest = () => /** @type {NetworkRequest|undefined} */ (undefined);
    this._responseHeaders = /** @type {LH.WebInspector.HeaderValue[]} */ ([]);

    this._fetchedViaServiceWorker = false;
    this._frameId = /** @type {string|undefined} */ ('');
    this._isLinkPreload = false;

    // Make sure we're compatible with old WebInspector.NetworkRequest
    // eslint-disable-next-line no-unused-vars
    const record = /** @type {LH.WebInspector.NetworkRequest} */ (this);
  }

  /**
   * @return {NetworkRequest}
   */
  clone() {
    return Object.assign(new NetworkRequest(), this);
  }

  /**
   * @param {NetworkRequest} initiator
   */
  setInitiatorRequest(initiator) {
    this.initiatorRequest = () => initiator;
  }

  /**
   * @param {LH.Crdp.Network.RequestWillBeSentEvent} data
   */
  onRequestWillBeSent(data) {
    this.requestId = data.requestId;
    this._requestId = data.requestId;

    const url = new URL(data.request.url);
    this.url = data.request.url;
    this._url = data.request.url;
    this.parsedURL = {
      scheme: url.protocol.split(':')[0],
      // Intentional, DevTools uses different terminalogy
      host: url.hostname,
      securityOrigin: () => url.origin,
    };

    this.startTime = data.timestamp;

    this.requestMethod = data.request.method;

    this._initiator = data.initiator;
    this._resourceType = data.type && resourceTypes[data.type];
    this.priority = () => data.request.initialPriority;

    this._frameId = data.frameId;
    this._isLinkPreload = data.initiator.type === 'preload' || !!data.request.isLinkPreload;
  }

  onRequestServedFromCache() {
    this._fromMemoryCache = true;
  }

  /**
   * @param {LH.Crdp.Network.ResponseReceivedEvent} data
   */
  onResponseReceived(data) {
    this._onResponse(data.response, data.timestamp, data.type);
    this._frameId = data.frameId;
  }

  /**
   * @param {LH.Crdp.Network.DataReceivedEvent} data
   */
  onDataReceived(data) {
    this._resourceSize += data.dataLength;
    if (data.encodedDataLength !== -1) {
      this.transferSize += data.encodedDataLength;
    }
  }

  /**
   * @param {LH.Crdp.Network.LoadingFinishedEvent} data
   */
  onLoadingFinished(data) {
    this.finished = true;
    this.endTime = data.timestamp;
    if (data.encodedDataLength >= 0) {
      this.transferSize = data.encodedDataLength;
    }

    this._updateResponseReceivedTimeIfNecessary();
  }

  /**
   * @param {LH.Crdp.Network.LoadingFailedEvent} data
   */
  onLoadingFailed(data) {
    this.finished = true;
    this.endTime = data.timestamp;

    this.failed = true;
    this._resourceType = data.type && resourceTypes[data.type];
    this.localizedFailDescription = data.errorText;

    this._updateResponseReceivedTimeIfNecessary();
  }

  /**
   * @param {LH.Crdp.Network.ResourceChangedPriorityEvent} data
   */
  onResourceChangedPriority(data) {
    this.priority = () => data.newPriority;
  }

  /**
   * @param {LH.Crdp.Network.RequestWillBeSentEvent} data
   */
  onRedirectResponse(data) {
    if (!data.redirectResponse) throw new Error('Missing redirectResponse data');
    this._onResponse(data.redirectResponse, data.timestamp, data.type);
    this._resourceType = undefined;
    this.finished = true;
    this.endTime = data.timestamp;

    this._updateResponseReceivedTimeIfNecessary();
  }

  /**
   * @param {LH.Crdp.Network.Response} response
   * @param {number} timestamp
   * @param {LH.Crdp.Network.ResponseReceivedEvent['type']=} resourceType
   */
  _onResponse(response, timestamp, resourceType) {
    this.connectionId = String(response.connectionId);
    this.connectionReused = response.connectionReused;

    if (response.protocol) this.protocol = response.protocol;

    this._responseReceivedTime = timestamp;

    this.transferSize = response.encodedDataLength;
    if (typeof response.fromDiskCache === 'boolean') this._fromDiskCache = response.fromDiskCache;

    this.statusCode = response.status;

    this._timing = response.timing;
    if (resourceType) this._resourceType = resourceTypes[resourceType];
    this._mimeType = response.mimeType;
    this._responseHeaders = NetworkRequest._headersDictToHeadersArray(response.headers);

    this._fetchedViaServiceWorker = !!response.fromServiceWorker;

    if (response.timing) this._recomputeTimesWithResourceTiming(response.timing);
  }

  /**
   * Resolve differences between conflicting timing signals. Based on the property setters in DevTools.
   * @see https://github.com/ChromeDevTools/devtools-frontend/blob/56a99365197b85c24b732ac92b0ac70feed80179/front_end/sdk/NetworkRequest.js#L485-L502
   * @param {LH.Crdp.Network.ResourceTiming} timing
   */
  _recomputeTimesWithResourceTiming(timing) {
    // Take startTime and responseReceivedTime from timing data for better accuracy.
    // Timing's requestTime is a baseline in seconds, rest of the numbers there are ticks in millis.
    this.startTime = timing.requestTime;
    const headersReceivedTime = timing.requestTime + timing.receiveHeadersEnd / 1000.0;
    if (!this._responseReceivedTime || this._responseReceivedTime < 0) {
      this._responseReceivedTime = headersReceivedTime;
    }

    this._responseReceivedTime = Math.min(this._responseReceivedTime, headersReceivedTime);
    this._responseReceivedTime = Math.max(this._responseReceivedTime, this.startTime);
    this.endTime = Math.max(this.endTime, this._responseReceivedTime);
  }

  _updateResponseReceivedTimeIfNecessary() {
    this._responseReceivedTime = Math.min(this.endTime, this._responseReceivedTime);
  }

  /**
   * Based on DevTools NetworkManager.
   * @see https://github.com/ChromeDevTools/devtools-frontend/blob/3415ee28e86a3f4bcc2e15b652d22069938df3a6/front_end/sdk/NetworkManager.js#L285-L297
   * @param {LH.Crdp.Network.Headers} headersDict
   * @return {Array<LH.WebInspector.HeaderValue>}
   */
  static _headersDictToHeadersArray(headersDict) {
    const result = [];
    for (const name of Object.keys(headersDict)) {
      const values = headersDict[name].split('\n');
      for (let i = 0; i < values.length; ++i) {
        result.push({name: name, value: values[i]});
      }
    }
    return result;
  }
};