// The script must not touch the local server on its own. The only GM requests it
// may ever make are the ones a proxy URL from the page asked for, aimed at a
// public host; every other route — /version, /hlsv2/*, /proxy/ without a target —
// is the browser's business. This is the guard for that: looking at the
// environment is all that happens at startup.

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { capabilities, detectCapabilities, resetCapabilities } from '../src/capabilities';
import { configureEnv, env } from '../src/env';
import { createFakeGm, respond } from './fakeGm';
import { fakePage } from './fakes';

let gm: ReturnType<typeof createFakeGm>;

beforeEach(() => {
  gm = createFakeGm(respond({ status: 200, body: 'version' }));
  configureEnv({ page: fakePage(), gmRequest: gm.fn, hls: null });
  resetCapabilities();
});

test('looking at the environment requests nothing', () => {
  const caps = detectCapabilities();

  assert.equal(caps.gm, true);
  assert.equal(caps.fetchHook, true);
  assert.equal(caps.xhrHook, true);
  assert.equal(gm.calls.length, 0, 'no request, in particular none to /version');
  assert.equal(capabilities(), caps, 'the answer is cached');
});

test('there is no stream probe any more to call', () => {
  // The stream support question is answered by the first real request instead,
  // so the module surface no longer offers a way to ask the local server.
  assert.equal('probeStreamSupport' in capabilities, false);
  resetCapabilities();
  assert.equal(gm.calls.length, 0);
  assert.equal(env.hls, null);
});
