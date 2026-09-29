import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_LOCAL_ORIGIN } from '../src/config';
import { configureEnv, env } from '../src/env';
import { isLocalProxyUrl, buildProxyUrl } from '../src/proxyUrl';
import { resetLocalServiceState } from '../src/localService';
import {
  getLocalOrigin,
  loadSettings,
  LOCAL_ORIGIN_KEY,
  saveLocalOrigin,
  setLocalOriginInMemory,
  validateLocalOrigin,
} from '../src/settings';

interface FakeStore {
  values: Map<string, string>;
  throwOnWrite: boolean;
}

function withStore(store: FakeStore | null, run: () => void): void {
  const previous = { get: env.gmGetValue, set: env.gmSetValue };
  if (store) {
    configureEnv({
      gmGetValue: (key: string) => store.values.get(key),
      gmSetValue: (key: string, value: string) => {
        if (store.throwOnWrite) throw new Error('storage full');
        store.values.set(key, value);
      },
    });
  } else {
    configureEnv({ gmGetValue: null, gmSetValue: null });
  }
  try {
    run();
  } finally {
    setLocalOriginInMemory(DEFAULT_LOCAL_ORIGIN);
    resetLocalServiceState();
    configureEnv({ gmGetValue: previous.get, gmSetValue: previous.set });
  }
}

function makeStore(initial: Record<string, string> = {}): FakeStore {
  return { values: new Map(Object.entries(initial)), throwOnWrite: false };
}

test('the default origin is what an unset script uses', () => {
  withStore(makeStore(), () => {
    loadSettings();
    assert.equal(getLocalOrigin(), DEFAULT_LOCAL_ORIGIN);
  });
});

test('a stored origin is read back', () => {
  withStore(makeStore({ [LOCAL_ORIGIN_KEY]: 'http://192.168.1.50:11470' }), () => {
    loadSettings();
    assert.equal(getLocalOrigin(), 'http://192.168.1.50:11470');
  });
});

test('saving writes the normalised origin and updates the live value', () => {
  withStore(makeStore(), () => {
    const result = saveLocalOrigin('  127.0.0.1:11471  ');
    assert.ok(result.ok);
    assert.equal(result.ok && result.origin, 'http://127.0.0.1:11471');
    assert.equal(getLocalOrigin(), 'http://127.0.0.1:11471');
  });
});

test('a rejected origin is not stored and leaves the live value alone', () => {
  const store = makeStore();
  withStore(store, () => {
    const result = saveLocalOrigin('https://evil.example.com');
    assert.equal(result.ok, false);
    assert.equal(store.values.has(LOCAL_ORIGIN_KEY), false);
    assert.equal(getLocalOrigin(), DEFAULT_LOCAL_ORIGIN);
  });
});

test('a storage failure is reported, not swallowed', () => {
  const store = makeStore();
  store.throwOnWrite = true;
  withStore(store, () => {
    const result = saveLocalOrigin('http://127.0.0.1:11470');
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /refused/);
  });
});

test('a stored origin that is not local falls back to the default', () => {
  withStore(makeStore({ [LOCAL_ORIGIN_KEY]: 'http://10.0.0.1' }), () => {
    // 10.x is a private address, so this one is accepted...
    loadSettings();
    assert.equal(getLocalOrigin(), 'http://10.0.0.1');
  });
  withStore(makeStore({ [LOCAL_ORIGIN_KEY]: 'http://example.com:11470' }), () => {
    // ...while a public hostname is not.
    loadSettings();
    assert.equal(getLocalOrigin(), DEFAULT_LOCAL_ORIGIN);
  });
  withStore(makeStore({ [LOCAL_ORIGIN_KEY]: 'not a url at all' }), () => {
    loadSettings();
    assert.equal(getLocalOrigin(), DEFAULT_LOCAL_ORIGIN);
  });
});

test('a manager without storage falls back to the default', () => {
  withStore(null, () => {
    loadSettings();
    assert.equal(getLocalOrigin(), DEFAULT_LOCAL_ORIGIN);
    const result = saveLocalOrigin('http://127.0.0.1:11470');
    assert.equal(result.ok, false);
  });
});

test('validation accepts loopback and private addresses', () => {
  for (const value of [
    'http://127.0.0.1:11470',
    '127.0.0.1:11470',
    'http://localhost:11470',
    'http://[::1]:11470',
    'http://192.168.1.10:11470',
    'http://10.1.2.3:8080',
  ]) {
    const result = validateLocalOrigin(value);
    assert.ok(result.ok, `expected ${value} to be accepted, got ${result.ok ? '' : result.error}`);
  }
});

test('validation rejects anything that is not a bare local origin', () => {
  const cases: Array<[string, RegExp]> = [
    ['https://evil.example.com', /not a local address/],
    ['file:///etc/passwd', /not supported/],
    ['ftp://127.0.0.1:11470', /not supported/],
    ['http://user:pw@127.0.0.1:11470', /username or password/],
    ['http://127.0.0.1:11470/proxy', /without a path/],
    ['http://127.0.0.1:11470/?a=1', /query or fragment/],
    ['', /empty/],
    ['   ', /empty/],
  ];
  for (const [value, pattern] of cases) {
    const result = validateLocalOrigin(value);
    assert.equal(result.ok, false, `expected ${JSON.stringify(value)} to be rejected`);
    assert.match(result.ok ? '' : result.error, pattern);
  }
  assert.equal(validateLocalOrigin(42).ok, false);
  assert.equal(validateLocalOrigin(null).ok, false);
  assert.equal(validateLocalOrigin(undefined).ok, false);
});

test('a very long value is rejected before it is parsed', () => {
  const result = validateLocalOrigin(`http://127.0.0.1:11470/${'a'.repeat(300)}`);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /longer than/);
});

test('the gate follows the configured origin', () => {
  withStore(makeStore(), () => {
    saveLocalOrigin('http://127.0.0.1:11472');
    assert.ok(isLocalProxyUrl('http://127.0.0.1:11472/proxy/?d=https://a.example.com/x'));
    // The default origin is no longer in scope.
    assert.equal(isLocalProxyUrl(`${DEFAULT_LOCAL_ORIGIN}/proxy/?d=https://a.example.com/x`), null);

    const built = buildProxyUrl('https://a.example.com/x');
    assert.ok(built.startsWith('http://127.0.0.1:11472/proxy/'), built);
  });
});
