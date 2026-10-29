const util = require('util')
const exec = util.promisify(require('child_process').exec)
const fs = require('fs')

const tapInterfaces = require('./tapInterfaces')
const db = require('./db')

// The decnet-gateway daemon's bridge port. The machines learned on it are
// its clients; each belongs to the owner of the gateway client with its
// DECnet address.
const gatewayTap = () => process.env.DECNET_GATEWAY_TAP || 'dngw0'

// The MACs `bridge fdb show` learned on br0's ports, as [port, mac].
const parseBridgeNodes = (stdout) =>
  stdout
    .split('\n')
    .map((line) => {
      const [mac, dev, tap, master, bridge, status] = line.split(' ')
      return { mac, tap, bridge, status }
    })
    .filter(({ bridge, status }) => bridge === 'br0' && status !== 'permanent')
    .map(({ mac, tap }) => [tap, mac])

const getBridgeNodes = async () => {
  const { stdout } = await exec('bridge fdb show')
  return parseBridgeNodes(stdout)
}

// Records the machines on the bridge: those behind an OpenVPN TAP as the
// TAP's user's, those on the gateway's port as their gateway client's
// owner's.
const updateHosts = async (bridgeNodes, tapToUser) => {
  const tap = gatewayTap()
  const gatewayMacs = bridgeNodes
    .filter(([port]) => port === tap)
    .map(([, mac]) => mac)
  const openvpnHosts = bridgeNodes
    .filter(([port]) => port !== tap && tapToUser[port])
    .map(([port, mac]) => [tapToUser[port], mac])
  await db.touchHosts(openvpnHosts)
  await db.touchGatewayHosts(gatewayMacs)
}

const startHostUpdater = () => {
  if (fs.existsSync(tapInterfaces.directory)) {
    setInterval(
      () =>
        getBridgeNodes()
          .then((nodes) => updateHosts(nodes, tapInterfaces.loadTapMap()))
          .catch((e) => console.log('host updater:', e.message)),
      1000
    )
  } else {
    console.log('No tap directory found, not starting host updater')
  }
}

module.exports = { startHostUpdater, parseBridgeNodes, updateHosts }
