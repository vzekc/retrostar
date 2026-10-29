// A decnet-gateway control socket speaking protocol v1, for tests.

const net = require('net')
const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const decnetMac = (address) => {
  const [area, node] = address.split('.').map(Number)
  const value = area * 1024 + node
  const hex = (n) => n.toString(16).padStart(2, '0')
  return `aa:00:04:00:${hex(value & 255)}:${hex(value >> 8)}`
}

const start = async () => {
  const socketPath = path.join(
    os.tmpdir(),
    `dngw-test-${process.pid}-${Date.now()}.sock`
  )
  const state = {
    clients: new Map(),
    nextKeyId: 1,
    connected: new Set(),
    requests: [],
    // op -> error code to answer the next request of that op with
    failNext: {},
  }

  const issue = (client) => {
    const key = crypto.randomBytes(32).toString('hex')
    client.key = key
    client.fingerprint = crypto
      .createHash('sha256')
      .update(key)
      .digest('hex')
      .slice(0, 16)
    return {
      ok: true,
      key_id: client.key_id,
      line: `DNGW1 retrostar.example 26003 ${client.key_id} ${client.address} ${key}`,
      fingerprint: client.fingerprint,
      mac: client.mac,
    }
  }

  const error = (code, message) => ({ ok: false, error: code, message })

  const handle = (req) => {
    state.requests.push(req)
    if (req.v !== 1) return error('unsupported', 'protocol version')
    const fail = state.failNext[req.op]
    if (fail) {
      delete state.failNext[req.op]
      return error(fail, `forced ${fail}`)
    }
    switch (req.op) {
      case 'hello':
        return { ok: true, protocol: 1, version: '0.0.0-test' }
      case 'add': {
        if (!req.name || !/^\d+\.\d+$/.test(req.address || '')) {
          return error('bad-request', 'name and address required')
        }
        for (const c of state.clients.values()) {
          if (c.address === req.address) return error('address-in-use')
          if (c.name === req.name) return error('exists')
        }
        const client = {
          key_id: state.nextKeyId++,
          name: req.name,
          address: req.address,
          mac: decnetMac(req.address),
          endnode_only: !!req.endnode_only,
        }
        state.clients.set(client.key_id, client)
        return issue(client)
      }
      case 'rekey': {
        const client = state.clients.get(req.key_id)
        return client ? issue(client) : error('not-found')
      }
      case 'remove':
        if (!state.clients.delete(req.key_id)) return error('not-found')
        state.connected.delete(req.key_id)
        return { ok: true }
      case 'list':
        return {
          ok: true,
          clients: [...state.clients.values()].map(
            ({ key_id, name, address, mac, fingerprint, endnode_only }) => ({
              key_id,
              name,
              address,
              mac,
              fingerprint,
              endnode_only,
            })
          ),
        }
      case 'stats': {
        const clients = [...state.clients.values()]
          .filter((c) => req.key_id === undefined || c.key_id === req.key_id)
          .map(({ key_id }) => {
            const connected = state.connected.has(key_id)
            return {
              key_id,
              connected,
              last_rx: connected ? Math.floor(Date.now() / 1000) : null,
              endpoint: connected ? '198.51.100.7:51234' : null,
              rx_packets: 10,
              rx_bytes: 1000,
              tx_packets: 5,
              tx_bytes: 500,
              drops: {
                bad_source: 0,
                ethertype: 0,
                replay: 0,
                auth: 0,
                rate: 0,
              },
            }
          })
        if (req.key_id !== undefined && clients.length === 0) {
          return error('not-found')
        }
        return { ok: true, clients }
      }
      default:
        return error('unsupported', `op ${req.op}`)
    }
  }

  const server = net.createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let response
        try {
          response = handle(JSON.parse(line))
        } catch (e) {
          response = error('bad-request', e.message)
        }
        socket.write(JSON.stringify(response) + '\n')
      }
    })
    socket.on('error', () => undefined)
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))

  const stop = () =>
    new Promise((resolve) => {
      server.close(() => {
        fs.rmSync(socketPath, { force: true })
        resolve()
      })
    })

  return { socketPath, state, stop }
}

module.exports = { start, decnetMac }
