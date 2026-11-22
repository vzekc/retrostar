// Members' OpenVPN configurations: a client certificate signed by the
// RetroStar CA and the UDP port of the OpenVPN server that serves it. A
// member sets up their own configuration from the installation page. The
// certificate's common name is the user name, which is how client-connect.sh
// and update_host() map a VPN connection to its owner.
//
// The webserver signs with the CA in the checkout's ca/ directory, as
// ca/new-cert.sh does. After a configuration is stored it writes the file
// data/servers-changed there; the systemd unit retrostar-openvpn-reload.path
// watches it and has start-openvpn-servers.sh start the servers of new
// configurations and stop those of removed ones.

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

// The name of an OpenVPN configuration is its config_name or, without one,
// its owner's user name. It names the certificate, the server and the
// machines behind it, so it is used once among configurations and user names.
// The user named owner may give their own name to a configuration.
const nameTaken = async (client, name, owner) =>
  (
    await client.query(
      `SELECT 1 FROM openvpn_configuration oc JOIN "user" u ON u.id = oc.user_id
       WHERE COALESCE(oc.config_name, u.name) = $1
       UNION ALL
       SELECT 1 FROM "user" WHERE name = $1 AND name IS DISTINCT FROM $2`,
      [name, owner || null]
    )
  ).rows.length > 0

class NameTaken extends Error {}

// Signs a certificate for the configuration named name of user, stores the
// configuration and answers its install key.
const addConfiguration = async (user, name) => {
  const { certificate, privateKey } = await signCertificate(name)
  const installKey = await db.withClient(async (client) => {
    const result = await client.query(
      `INSERT INTO openvpn_configuration
         (user_id, config_name, certificate, private_key)
       VALUES ($1, $2, $3, $4)
       RETURNING install_key`,
      [user.id, name === user.username ? null : name, certificate, privateKey]
    )
    return result.rows[0].install_key
  })
  signalServers()
  return installKey
}

// Sets up the configuration of user and answers its install key. A user who
// has a configuration keeps it.
const createConfiguration = (user) =>
  serialized(async () => {
    if (!canSelfIssue(user.username)) {
      throw new Error(`user name ${user.username} is not a certificate name`)
    }
    const existing = await db.withClient(async (client) => {
      const keys = await db.getInstallKeysByUser(client, user.username)
      if (!keys.length) {
        const other = await client.query(
          `SELECT 1 FROM openvpn_configuration WHERE config_name = $1`,
          [user.username]
        )
        if (other.rows.length) {
          throw new NameTaken(
            `Der Name ${user.username} gehört schon zu einem VPN-Zugang`
          )
        }
      }
      return keys
    })
    if (existing.length) {
      return existing[0].install_key
    }
    const installKey = await addConfiguration(user, user.username)
    await event.publish(
      'openvpn-configuration',
      `${user.username} hat einen RetroStar-Zugang eingerichtet`,
      { username: user.username }
    )
    return installKey
  })

// Sets up another configuration, named name, for user.
const addClient = (user, name) =>
  serialized(async () => {
    if (!canSelfIssue(name)) {
      throw new NameTaken(
        `${name} eignet sich nicht als Name eines VPN-Zugangs`
      )
    }
    if (
      await db.withClient((client) => nameTaken(client, name, user.username))
    ) {
      throw new NameTaken(`Der Name ${name} ist schon vergeben`)
    }
    return addConfiguration(user, name)
  })

// Revokes certificates in the CA and writes its revocation list
// data/crl.pem. A certificate the CA already revoked stays revoked.
const revokeCertificates = (certificates) =>
  serialized(async () => {
    if (!certificates.length) return
    const file = path.join('data', `revoke-${process.pid}-${Date.now()}.pem`)
    try {
      for (const certificate of certificates) {
        fs.writeFileSync(path.join(caDirectory(), file), certificate)
        try {
          await openssl([
            'ca',
            '-config',
            'ca.cnf',
            '-revoke',
            file,
            '-crl_reason',
            'cessationOfOperation',
          ])
        } catch (e) {
          if (!/Already revoked/i.test(`${e.stderr}${e.stdout}`)) throw e
        }
      }
    } finally {
      fs.rmSync(path.join(caDirectory(), file), { force: true })
    }
    await openssl([
      'ca',
      '-config',
      'ca.cnf',
      '-gencrl',
      '-out',
      'data/crl.pem',
      '-crldays',
      '3650',
    ])
  })

module.exports = {
  NameTaken,
  nameTaken,
  addClient,
  canSelfIssue,
  caFile,
  createConfiguration,
  revokeCertificates,
  signalServers,
}
