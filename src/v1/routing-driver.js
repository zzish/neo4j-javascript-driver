/**
 * Copyright (c) 2002-2017 "Neo Technology,","
 * Network Engine for Objects in Lund AB [http://neotechnology.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Session from "./session";
import {Driver, READ, WRITE} from "./driver";
import {newError, SERVICE_UNAVAILABLE, SESSION_EXPIRED} from "./error";
import RoundRobinArray from "./internal/round-robin-array";
import RoutingTable from "./internal/routing-table";
import Rediscovery from "./internal/rediscovery";

/**
 * A driver that supports routing in a core-edge cluster.
 */
class RoutingDriver extends Driver {

  constructor(url, userAgent, token = {}, config = {}) {
    super(url, userAgent, token, RoutingDriver._validateConfig(config));
    this._routingTable = new RoutingTable(new RoundRobinArray([url]));
    this._rediscovery = new Rediscovery();
  }

  _createSession(connectionPromise, cb) {
    return new RoutingSession(connectionPromise, cb, (err, conn) => {
      let code = err.code;
      let msg = err.message;
      if (!code) {
        try {
          code = err.fields[0].code;
        } catch (e) {
          code = 'UNKNOWN';
        }
      }
      if (!msg) {
        try {
          msg = err.fields[0].message;
        } catch (e) {
          msg = 'Unknown failure occurred';
        }
      }
      //just to simplify later error handling
      err.code = code;
      err.message = msg;

      if (code === SERVICE_UNAVAILABLE || code === SESSION_EXPIRED) {
        if (conn) {
          this._forget(conn.url)
        } else {
          connectionPromise.then((conn) => {
            this._forget(conn.url);
          }).catch(() => {/*ignore*/});
        }
        return err;
      } else if (code === 'Neo.ClientError.Cluster.NotALeader') {
        let url = 'UNKNOWN';
        if (conn) {
          url = conn.url;
          this._routingTable.writers.remove(conn.url);
        } else {
          connectionPromise.then((conn) => {
            this._routingTable.writers.remove(conn.url);
          }).catch(() => {/*ignore*/});
        }
        return newError("No longer possible to write to server at " + url, SESSION_EXPIRED);
      } else {
        return err;
      }
    });
  }

  _refreshedRoutingTable() {
    const currentRoutingTable = this._routingTable;

    if (!currentRoutingTable.isStale()) {
      return Promise.resolve(currentRoutingTable);
    }

    const knownRouters = currentRoutingTable.routers.toArray();

    const refreshedTablePromise = knownRouters.reduce((refreshedTablePromise, currentRouter, currentIndex) => {
      return refreshedTablePromise.then(newRoutingTable => {
        if (newRoutingTable) {
          // correct routing table was fetched, just return it
          return newRoutingTable
        }

        // returned routing table was undefined, this means a connection error happened and we need to forget the
        // previous router and try the next one
        const previousRouter = knownRouters[currentIndex - 1];
        if (previousRouter) {
          this._forget(previousRouter);
        }

        // todo: properly close this connection
        const connection = this._pool.acquire(currentRouter);
        const session = this._createSession(Promise.resolve(connection));

        // try next router
        return this._rediscovery.lookupRoutingTableOnRouter(session, currentRouter);
      })
    }, Promise.resolve(null));

    return refreshedTablePromise.then(newRoutingTable => {
      if (newRoutingTable) {
        // valid routing table fetched, close old connections to servers not present in the new routing table
        const staleServers = currentRoutingTable.serversDiff(newRoutingTable);
        staleServers.forEach(server => this._pool.purge);

        // make this driver instance aware of the new table
        this._routingTable = newRoutingTable;

        return newRoutingTable
      }
      throw newError('Could not perform discovery. No routing servers available.', SERVICE_UNAVAILABLE);
    });
  }

  _acquireConnection(mode) {
    return this._refreshedRoutingTable().then(routingTable => {
      if (mode === READ) {
        return this._acquireConnectionToServer(routingTable.readers, "read");
      } else if (mode === WRITE) {
        return this._acquireConnectionToServer(routingTable.writers, "write");
      } else {
        throw newError('Illegal session mode ' + mode);
      }
    });
  }

  _acquireConnectionToServer(serversRoundRobinArray, serverName) {
    const address = serversRoundRobinArray.next();
    if (!address) {
      return Promise.reject(newError('No ' + serverName + ' servers available', SESSION_EXPIRED));
    }
    return this._pool.acquire(address);
  }

  _forget(url) {
    this._routingTable.forget(url);
    this._pool.purge(url);
  }

  static _validateConfig(config) {
    if(config.trust === 'TRUST_ON_FIRST_USE') {
      throw newError('The chosen trust mode is not compatible with a routing driver');
    }
    return config;
  }
}

class RoutingSession extends Session {
  constructor(connectionPromise, onClose, onFailedConnection) {
    super(connectionPromise, onClose);
    this._onFailedConnection = onFailedConnection;
  }

  _onRunFailure() {
    return this._onFailedConnection;
  }
}

export default RoutingDriver
