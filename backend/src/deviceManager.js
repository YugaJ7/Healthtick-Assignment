'use strict';

const { execFile } = require('node:child_process');
const { adb, adbConnect, adbDisconnect } = require('./adb');
const { config } = require('./config');
const { logger } = require('./logger');
const { applyRestriction } = require('./restriction');
const { hardenDevice } = require('./hardening');

// Every Android device is its own redroid container: its own file system, settings and
// apps. Containers are created for one session and removed with it, so nothing carries
// over from one user to the next.

const DOCKER_TIMEOUT_MS = 60_000;
const BOOT_POLL_MS = 500;
const NAME_PREFIX = 'android-web-';
const SESSION_LABEL = 'android-web=session';
const ADB_PORT_IN_CONTAINER = '5555/tcp';
const BRIDGE_NAME_OPTION = 'com.docker.network.bridge.name';

function docker(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: DOCKER_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`docker ${args[0]} failed: ${(stderr || err.message).trim()}`));
      resolve(stdout.trim());
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Containers on this network cannot talk to each other (inter-container traffic is off),
// so one user's device cannot reach another's. They can still reach the internet.
// The bridge has a fixed name so that the host firewall (infra/device-firewall.sh) can
// keep devices away from the server itself, the private network and the cloud's
// metadata address.
async function ensureNetwork() {
  const { network, bridge } = config.device;
  const existing = await docker(['network', 'ls', '--filter', `name=^${network}$`, '--format', '{{.Name}}']);
  if (existing === network) {
    const currentBridge = await docker(['network', 'inspect', '-f', `{{index .Options "${BRIDGE_NAME_OPTION}"}}`, network]);
    if (currentBridge === bridge) return;
    // Made by an earlier version, with a bridge name Docker picked: the firewall would miss it.
    await docker(['network', 'rm', network]);
  }
  await docker(['network', 'create', '-o', 'com.docker.network.bridge.enable_icc=false', '-o', `${BRIDGE_NAME_OPTION}=${bridge}`, network]);
}

// Removes device containers left behind by an earlier run of the backend (a crash or kill).
async function removeOrphans() {
  const ids = await docker(['ps', '-aq', '--filter', `label=${SESSION_LABEL}`]);
  if (ids === '') return 0;
  const list = ids.split('\n');
  await docker(['rm', '-f', ...list]);
  return list.length;
}

async function waitForBoot(serial, deadline) {
  while (Date.now() < deadline) {
    try {
      await adbConnect(serial);
      if ((await adb(serial, ['shell', 'getprop', 'sys.boot_completed'])) === '1') return;
    } catch {
      // Not reachable yet: adbd inside the container starts a moment after the container does.
    }
    await sleep(BOOT_POLL_MS);
  }
  throw new Error('device did not finish booting in time');
}

/**
 * Creates and boots one device. On any failure the container is removed again.
 * @param {string} id short identifier used in the container name
 * @param {'full' | 'restricted'} mode a restricted device is locked to one app before it is handed out
 * @returns {Promise<{ name: string, serial: string }>}
 */
async function createDevice(id, mode) {
  const name = `${NAME_PREFIX}${id}`;
  const { image, network, memory, cpus, width, height, fps, bootTimeoutMs } = config.device;
  try {
    await docker([
      'run', '-d', '--privileged', '--name', name, '--label', SESSION_LABEL,
      '--network', network, '--memory', memory, '--cpus', cpus,
      // ADB is reachable from this host only, on a port Docker picks.
      '-p', '127.0.0.1::5555', image,
      'androidboot.redroid_gpu_mode=guest',
      `androidboot.redroid_width=${width}`, `androidboot.redroid_height=${height}`, `androidboot.redroid_fps=${fps}`,
    ]);
    const mapping = await docker(['port', name, ADB_PORT_IN_CONTAINER]);
    const port = Number(mapping.split('\n')[0].split(':').pop());
    if (!Number.isInteger(port) || port <= 0) throw new Error(`unexpected port mapping "${mapping}"`);
    const serial = `127.0.0.1:${port}`;
    await waitForBoot(serial, Date.now() + bootTimeoutMs);
    await hardenDevice((args) => docker(['exec', name, ...args]));
    await adb(serial, ['push', config.scrcpy.localJar, config.scrcpy.deviceJar]);
    if (mode === 'restricted') await applyRestriction(serial);
    return { name, serial };
  } catch (err) {
    await removeDevice({ name, serial: null });
    throw err;
  }
}

/**
 * Removes a device and everything stored on it. Never throws: a failure is logged,
 * and the orphan cleanup at the next start is the safety net.
 * @param {{ name: string, serial: string | null }} device
 */
async function removeDevice(device) {
  try {
    if (device.serial) await adbDisconnect(device.serial).catch(() => {});
    await docker(['rm', '-f', device.name]);
  } catch (err) {
    logger.error(`could not remove ${device.name}: ${err.message}`);
  }
}

module.exports = { ensureNetwork, removeOrphans, createDevice, removeDevice };
