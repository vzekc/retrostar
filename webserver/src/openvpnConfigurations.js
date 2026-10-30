// Members' OpenVPN configurations: a client certificate signed by the
// RetroStar CA and the UDP port of the OpenVPN server that serves it. A
// member sets up their own configuration from the installation page. The
// certificate's common name is the user name, which is how client-connect.sh
// and update_host() map a VPN connection to its owner.
//
// The webserver signs with the CA in the checkout's ca/ directory, as
// ca/new-cert.sh does. After a configuration is stored it writes the file
// data/servers-changed there; the systemd unit retrostar-openvpn-reload.path
// watches it and has start-openvpn-servers.sh start the new server.

const fs = require('fs')
const path = require('path')
const util = require('util')
const execFile = util.promisify(require('child_process').execFile)

const db = require('./db')
const event = require('./event')

// Names that serve as certificate common name, file name and a word in
// start-openvpn-servers.sh.
const NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/

const caDirectory = () =>
  process.env.OPENVPN_CA_DIR || path.join(__dirname, '..', '..', 'ca')

const caFile = (name) =>
  fs.readFileSync(path.join(caDirectory(), 'data', name), {
    encoding: 'utf8',
  })

const canSelfIssue = (username) => NAME_PATTERN.test(username)

// openssl ca keeps its index and serial in files, so signings run one at a
// time.
let signing = Promise.resolve()

const serialized = (fn) => {
  const result = signing.then(fn)
  signing = result.catch(() => {})
  return result
}

const openssl = (args) =>
  execFile('openssl', args, { cwd: caDirectory(), timeout: 60000 })

const signCertificate = async (name) => {
  const key = `data/${name}.key`
  const csr = `data/${name}.csr`
  const crt = `data/${name}.crt`
  try {
    await openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      csr,
      '-subj',
      `/CN=${name}`,
    ])
    await openssl([
      'ca',
      '-config',
      'ca.cnf',
      '-batch',
      '-in',
      csr,
      '-out',
      crt,
      '-notext',
    ])
  } finally {
    fs.rmSync(path.join(caDirectory(), csr), { force: true })
  }
  return {
    certificate: fs.readFileSync(path.join(caDirectory(), crt), 'utf8'),
    privateKey: fs.readFileSync(path.join(caDirectory(), key), 'utf8'),
  }
}

const signalServers = () =>
  fs.writeFileSync(
    path.join(caDirectory(), 'data', 'servers-changed'),
    `${new Date().toISOString()}\n`
  )

// Sets up the configuration of user and answers its install key. A user who
// has a configuration keeps it.
const createConfiguration = (user) =>
  serialized(async () => {
    if (!canSelfIssue(user.username)) {
      throw new Error(`user name ${user.username} is not a certificate name`)
    }
    const existing = await db.withClient(async (client) =>
      db.getInstallKeysByUser(client, user.username)
    )
    if (existing.length) {
      return existing[0].install_key
    }
    const { certificate, privateKey } = await signCertificate(user.username)
    const installKey = await db.withClient(async (client) => {
      const result = await client.query(
        `INSERT INTO openvpn_configuration (user_id, certificate, private_key)
         VALUES ($1, $2, $3)
         RETURNING install_key`,
        [user.id, certificate, privateKey]
      )
      return result.rows[0].install_key
    })
    signalServers()
    await event.publish(
      'openvpn-configuration',
      `${user.username} hat einen RetroStar-Zugang eingerichtet`,
      { username: user.username }
    )
    return installKey
  })

module.exports = { canSelfIssue, caFile, createConfiguration }
