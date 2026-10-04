'use strict';

// Applied to every device before a visitor gets it, in both modes.
//
// Why: the device's debugging service (adbd) listens on TCP port 5555 inside the
// container and asks for no authentication. The server uses it
// through the container's network interface (eth0). An app running on the device could
// connect to the same port on the device's own address and get a shell inside a
// privileged container, a step towards the server. So:
//   1. Port 5555 accepts connections that arrive on eth0 only; inter-container traffic
//      is off on that network, so that leaves the server.
//   2. Visitors cannot install apps, which removes the way to run such code at all.

const ADB_PORT = '5555';
// "-w" waits for the firewall lock, which Android's own network service may hold.
const ADB_PORT_RULE = ['-w', '-I', 'INPUT', '-p', 'tcp', '--dport', ADB_PORT, '!', '-i', 'eth0', '-j', 'DROP'];
const USER_RESTRICTIONS = ['no_install_apps', 'no_install_unknown_sources'];

/**
 * @param {(args: string[]) => Promise<string>} execAsRoot runs a command in the booted device's container as root
 */
async function hardenDevice(execAsRoot) {
  await execAsRoot(['/system/bin/iptables', ...ADB_PORT_RULE]);
  await execAsRoot(['/system/bin/ip6tables', ...ADB_PORT_RULE]);
  for (const restriction of USER_RESTRICTIONS) {
    // Needs root: the adb shell user is not allowed to set user restrictions.
    await execAsRoot(['/system/bin/pm', 'set-user-restriction', '--user', '0', restriction, '1']);
  }
}

module.exports = { hardenDevice };
