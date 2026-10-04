'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionManager, BusyError, LimitError } = require('../src/sessionManager');

const GRACE_MS = 30_000;
const IDLE_MS = 300_000;

// A fake device layer that records what was created and removed.
function setup(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created = [];
  const removed = [];
  const manager = createSessionManager({
    createDevice: async (id) => {
      const device = { name: `device-${id}` };
      created.push(device.name);
      return device;
    },
    removeDevice: async (device) => { removed.push(device.name); },
    maxSessions: 3,
    graceMs: GRACE_MS,
    idleMs: IDLE_MS,
    log: () => {},
    ...overrides,
  });
  return { manager, created, removed };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('each new session gets its own device and an unguessable token', async (t) => {
  const { manager, created } = setup(t);

  const a = manager.attach(null, () => {});
  const b = manager.attach(null, () => {});
  await settle();

  assert.equal(created.length, 2);
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[0-9a-f]{32}$/);
  assert.notEqual((await a.ready).name, (await b.ready).name);
  assert.equal(a.token.includes(a.id), false);
});

test('a known token resumes the same session instead of creating a device', async (t) => {
  const { manager, created } = setup(t);
  const onEnd = () => {};
  const first = manager.attach(null, onEnd);
  manager.detach(first, onEnd);

  const again = manager.attach(first.token, () => {});
  await settle();

  assert.equal(again, first);
  assert.equal(created.length, 1);
});

test('an unknown token starts a new session; it cannot join another one', async (t) => {
  const { manager } = setup(t);
  const real = manager.attach(null, () => {});

  const other = manager.attach('0'.repeat(32), () => {});

  assert.notEqual(other, real);
  assert.equal(manager.count(), 2);
});

test('refuses a new session when all devices are in use', (t) => {
  const { manager } = setup(t);
  for (let i = 0; i < 3; i += 1) manager.attach(null, () => {});

  assert.throws(() => manager.attach(null, () => {}), BusyError);
  assert.equal(manager.count(), 3);
});

test('one address cannot hold more than its share of the devices', (t) => {
  const { manager } = setup(t, { maxPerOwner: 2 });
  manager.attach(null, () => {}, 'full', '203.0.113.7');
  manager.attach(null, () => {}, 'full', '203.0.113.7');

  assert.throws(() => manager.attach(null, () => {}, 'full', '203.0.113.7'), LimitError);
  assert.equal(manager.count(), 2);
  assert.doesNotThrow(() => manager.attach(null, () => {}, 'full', '198.51.100.9'));
});

test('an address gets its place back when one of its sessions ends', (t) => {
  const { manager } = setup(t, { maxPerOwner: 1 });
  const first = manager.attach(null, () => {}, 'full', '203.0.113.7');

  manager.end(first, 'ended by user');

  assert.doesNotThrow(() => manager.attach(null, () => {}, 'full', '203.0.113.7'));
});

test('resuming a session with its token is not counted as a new one', (t) => {
  const { manager } = setup(t, { maxPerOwner: 1 });
  const first = manager.attach(null, () => {}, 'full', '203.0.113.7');

  const again = manager.attach(first.token, () => {}, 'full', '203.0.113.7');

  assert.equal(again, first);
});

test('sessions without an owner are not limited per address', (t) => {
  const { manager } = setup(t, { maxPerOwner: 1 });

  manager.attach(null, () => {});

  assert.doesNotThrow(() => manager.attach(null, () => {}));
});

test('tells the owner of the manager once when a session has ended', (t) => {
  const ended = [];
  const { manager } = setup(t, { onEnded: (session) => ended.push(session.id) });
  const session = manager.attach(null, () => {});

  manager.end(session, 'ended by user');
  manager.end(session, 'ended by user');

  assert.deepEqual(ended, [session.id]);
});

test('removes the device when the viewer stays away longer than the grace time', async (t) => {
  const { manager, removed } = setup(t);
  const onEnd = () => {};
  const session = manager.attach(null, onEnd);
  await settle();

  manager.detach(session, onEnd);
  t.mock.timers.tick(GRACE_MS - 1);
  await settle();
  assert.equal(removed.length, 0);

  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(removed, [`device-${session.id}`]);
  assert.equal(manager.count(), 0);
});

test('keeps the device when the viewer comes back within the grace time', async (t) => {
  const { manager, removed } = setup(t);
  const onEnd = () => {};
  const session = manager.attach(null, onEnd);
  manager.detach(session, onEnd);
  t.mock.timers.tick(GRACE_MS - 1);

  manager.attach(session.token, () => {});
  t.mock.timers.tick(GRACE_MS);
  await settle();

  assert.equal(removed.length, 0);
  assert.equal(manager.count(), 1);
});

test('ends an idle session and tells the viewer why; input postpones it', async (t) => {
  const { manager, removed } = setup(t);
  const reasons = [];
  const session = manager.attach(null, (reason) => reasons.push(reason));
  await settle();

  t.mock.timers.tick(IDLE_MS - 1);
  manager.touch(session);
  t.mock.timers.tick(IDLE_MS - 1);
  assert.deepEqual(reasons, []);

  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(reasons, ['idle']);
  assert.equal(removed.length, 1);
});

test('ending a session frees its slot and removes its device exactly once', async (t) => {
  const { manager, removed } = setup(t);
  const session = manager.attach(null, () => {});
  await settle();

  manager.end(session, 'ended by user');
  manager.end(session, 'ended by user');
  await settle();

  assert.equal(removed.length, 1);
  assert.equal(manager.count(), 0);
});

test('a device that fails to start ends the session and frees the slot', async (t) => {
  const reasons = [];
  const { manager, removed } = setup(t, { createDevice: async () => { throw new Error('boot failed'); } });

  manager.attach(null, (reason) => reasons.push(reason));
  await settle();

  assert.deepEqual(reasons, ['the device could not be started']);
  assert.equal(manager.count(), 0);
  assert.equal(removed.length, 0);
});

test('a session ended while its device is still starting removes the device once it exists', async (t) => {
  let finishBoot;
  const { manager, removed } = setup(t, {
    createDevice: () => new Promise((resolve) => { finishBoot = () => resolve({ name: 'late-device' }); }),
  });
  const session = manager.attach(null, () => {});

  manager.end(session, 'ended by user');
  assert.equal(removed.length, 0);
  finishBoot();
  await settle();

  assert.deepEqual(removed, ['late-device']);
});

test('a second viewer with the same token replaces the first', (t) => {
  const { manager } = setup(t);
  const reasons = [];
  const session = manager.attach(null, (reason) => reasons.push(reason));

  manager.attach(session.token, () => {});

  assert.deepEqual(reasons, ['opened in another window']);
  assert.equal(manager.count(), 1);
});

test('the mode is fixed when the session is created and cannot be changed by reconnecting', async (t) => {
  const modes = [];
  const { manager } = setup(t, {
    createDevice: async (id, mode) => {
      modes.push(mode);
      return { name: `device-${id}` };
    },
  });

  const restricted = manager.attach(null, () => {}, 'restricted');
  const again = manager.attach(restricted.token, () => {}, 'full');
  const plain = manager.attach(null, () => {});
  await settle();

  assert.equal(again, restricted);
  assert.equal(again.mode, 'restricted');
  assert.equal(plain.mode, 'full');
  assert.deepEqual(modes, ['restricted', 'full']);
});

test('endAll removes every device', async (t) => {
  const { manager, removed } = setup(t);
  manager.attach(null, () => {});
  manager.attach(null, () => {});
  await settle();

  manager.endAll('server shutting down');
  await settle();

  assert.equal(removed.length, 2);
  assert.equal(manager.count(), 0);
});
