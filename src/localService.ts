// Whether the local service is answering at all.
//
// Every request this script makes through GM_xmlhttpRequest targets the
// configured local service (http://127.0.0.1:11470 by default), so a transport
// level failure means the local service is not there, not that the CDN behind it
// hiccuped: the hop we would retry is the hop that just failed.
//
// Once that has happened a couple of times in a row the script stops intervening
// for the rest of the page load. A page whose own request to a dead local service
// fails immediately and natively is in a far better position than a page waiting
// on this script to fail on its behalf, and nothing can be played through a
// service that is not running, so the honest thing to do is get out of the way.
// A single success closes the circuit again, so a service that comes back mid
// visit is picked up without a reload.

import { LOCAL_SERVICE_FAILURE_THRESHOLD } from './config';

let consecutiveUnreachable = 0;
let down = false;
let circuitOrigin = '';

export function isLocalServiceDown(): boolean {
  return down;
}

/** A request that never got a response. Returns the new state. */
export function noteLocalUnreachable(): boolean {
  consecutiveUnreachable += 1;
  if (consecutiveUnreachable >= LOCAL_SERVICE_FAILURE_THRESHOLD) down = true;
  return down;
}

/** Any response at all, including a 4xx: the service is there and answering. */
export function noteLocalReachable(): void {
  consecutiveUnreachable = 0;
  down = false;
}

export function resetLocalServiceState(): void {
  consecutiveUnreachable = 0;
  down = false;
}

/** A new local URL is a new service: the circuit must not carry over. */
export function resetLocalServiceCircuit(origin: string): void {
  if (circuitOrigin === origin) return;
  circuitOrigin = origin;
  resetLocalServiceState();
}
