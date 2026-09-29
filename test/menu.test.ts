import assert from 'node:assert/strict';
import test from 'node:test';

import { configureEnv, env } from '../src/env';
import { registerMenu } from '../src/menu';
import { DEFAULT_LOCAL_ORIGIN } from '../src/config';
import { buildProxyUrl } from '../src/proxyUrl';
import { resetLocalServiceState } from '../src/localService';
import { getLocalOrigin, LOCAL_ORIGIN_KEY, saveLocalOrigin, setLocalOriginInMemory } from '../src/settings';

interface Recorded {
  caption: string;
  handler: () => void;
}

/** Stands in for the manager: stores values, records menus, and holds prompts. */
function fakeManager(options: { withMenu?: boolean; answers?: unknown[] } = {}) {
  const values = new Map<string, string>();
  const menus: Recorded[] = [];
  const prompts: string[] = [];
  const answers = [...(options.answers ?? [])];
  const previous = { ...env };

  const page: Record<string, unknown> = {
    prompt: (_message: string, initial?: string) => {
      prompts.push(initial ?? '');
      return answers.length > 0 ? answers.shift() : null;
    },
    alert: () => undefined,
    confirm: () => true,
  };

  configureEnv({
    page,
    gmGetValue: (key: string) => values.get(key),
    gmSetValue: (key: string, value: string) => {
      values.set(key, value);
    },
    gmDeleteValue: (key: string) => {
      values.delete(key);
    },
    gmRegisterMenuCommand:
      options.withMenu === false
        ? null
        : (caption: string, handler: () => void) => {
            menus.push({ caption, handler });
            return menus.length;
          },
  });

  return {
    values,
    menus,
    prompts,
    run(caption: string): void {
      const entry = menus.find((m) => m.caption === caption);
      assert.ok(entry, `no menu entry called ${JSON.stringify(caption)}`);
      entry.handler();
    },
    restore(): void {
      setLocalOriginInMemory(DEFAULT_LOCAL_ORIGIN);
      resetLocalServiceState();
      configureEnv(previous);
    },
  };
}

test('the three commands are registered in a manager that has a menu', () => {
  const manager = fakeManager();
  try {
    assert.equal(registerMenu(), 3);
    assert.deepEqual(
      manager.menus.map((m) => m.caption),
      ['Set local service URL', 'Show local service URL', 'Reset local service URL'],
    );
  } finally {
    manager.restore();
  }
});

test('a manager without the menu API registers nothing and does not throw', () => {
  const manager = fakeManager({ withMenu: false });
  try {
    assert.equal(registerMenu(), 0);
    assert.equal(manager.menus.length, 0);
  } finally {
    manager.restore();
  }
});

test('the set command stores a valid URL and the gate follows it', () => {
  const manager = fakeManager({ answers: ['http://127.0.0.1:11472'] });
  try {
    registerMenu();
    manager.run('Set local service URL');

    assert.equal(manager.values.get(LOCAL_ORIGIN_KEY), 'http://127.0.0.1:11472');
    assert.equal(getLocalOrigin(), 'http://127.0.0.1:11472');
    assert.ok(buildProxyUrl('https://a.example.com/x').startsWith('http://127.0.0.1:11472/proxy/'));
  } finally {
    manager.restore();
  }
});

test('cancelling the prompt changes nothing', () => {
  const manager = fakeManager({ answers: [null] });
  try {
    registerMenu();
    manager.run('Set local service URL');
    assert.equal(manager.values.has(LOCAL_ORIGIN_KEY), false);
    assert.equal(getLocalOrigin(), DEFAULT_LOCAL_ORIGIN);
  } finally {
    manager.restore();
  }
});

test('an invalid URL is not stored', () => {
  const manager = fakeManager({ answers: ['https://evil.example.com'] });
  try {
    registerMenu();
    manager.run('Set local service URL');
    assert.equal(manager.values.has(LOCAL_ORIGIN_KEY), false);
    assert.equal(getLocalOrigin(), DEFAULT_LOCAL_ORIGIN);
  } finally {
    manager.restore();
  }
});

test('the prompt is seeded with the origin in use', () => {
  const manager = fakeManager({ answers: ['http://10.0.0.5:11470'] });
  try {
    registerMenu();
    manager.run('Set local service URL');
    manager.run('Set local service URL');
    assert.deepEqual(manager.prompts, ['http://127.0.0.1:11470', 'http://10.0.0.5:11470']);
  } finally {
    manager.restore();
  }
});

test('the reset command puts the default back', () => {
  const manager = fakeManager();
  try {
    saveLocalOrigin('http://127.0.0.1:11472');
    registerMenu();
    manager.run('Reset local service URL');
    assert.equal(manager.values.get(LOCAL_ORIGIN_KEY), DEFAULT_LOCAL_ORIGIN);
    assert.equal(getLocalOrigin(), DEFAULT_LOCAL_ORIGIN);
  } finally {
    manager.restore();
  }
});
