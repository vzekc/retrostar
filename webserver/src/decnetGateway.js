// Client of the decnet-gateway daemon's control socket
// (DECNET_GATEWAY_SOCKET, default /run/decnet-gateway/control.sock).
// Protocol v1: a request is one line of JSON with "v": 1 and "op", answered
// by one line of JSON; a failed request answers
// {"ok": false, "error": code, "message": text}.

const net = require('net')

const PROTOCOL = 1
const TIMEOUT_MS = 5000

const socketPath = () =>
  process.env.DECNET_GATEWAY_SOCKET || '/run/decnet-gateway/control.sock'

// The gateway refused a request; code is one of unsupported, bad-request,
// exists, not-found, address-in-use.
class GatewayError extends Error {
  constructor(code, message) {
    super(message || code)
    this.code = code
  }
}

// The control socket cannot be reached: the daemon is not installed or not
// running.
class GatewayUnavailable extends Error {
  constructor(message) {
    super(message)
    this.code = 'unavailable'
  }
}

const request = (op, fields = {}) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath())
    let buffer = ''
    let done = false
    const finish = (error, result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      error ? reject(error) : resolve(result)
    }
    const timer = setTimeout(
      () => finish(new GatewayUnavailable(`${op}: no answer`)),
      TIMEOUT_MS
    )
    socket.setEncoding('utf8')
    socket.on('connect', () =>
      socket.write(JSON.stringify({ v: PROTOCOL, op, ...fields }) + '\n')
    )
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      let response
      try {
        response = JSON.parse(buffer.slice(0, newline))
      } catch (e) {
        return finish(new GatewayError('bad-response', e.message))
      }
      if (response.ok) {
        finish(null, response)
      } else {
        finish(new GatewayError(response.error, response.message))
      }
    })
    socket.on('error', (e) => finish(new GatewayUnavailable(e.message)))
    socket.on('close', () =>
      finish(new GatewayUnavailable(`${op}: connection closed`))
    )
  })

// The client's name at the gateway: the record's id ties it to the database,
// the rest is for people reading `decnet-gateway list-clients`.
const clientName = (id, username, name) => `rs:${id} ${username}/${name}`

// The record id of a gateway client named by clientName, or null.
const recordId = (gatewayName) => {
  const match = /^rs:([0-9a-f-]{36})(\s|$)/.exec(gatewayName || '')
  return match ? match[1] : null
}

const hello = () => request('hello')

const add = (name, nodeNumber) =>
  request('add', { name, address: `23.${nodeNumber}`, endnode_only: true })

const rekey = (keyId) => request('rekey', { key_id: keyId })

const remove = (keyId) => request('remove', { key_id: keyId })

const list = async () => (await request('list')).clients

const stats = async (keyId) =>
  (await request('stats', keyId === undefined ? {} : { key_id: keyId })).clients

// Removes a client at the gateway; one the gateway does not know is gone
// already.
const removeIfPresent = async (keyId) => {
  try {
    await remove(keyId)
  } catch (e) {
    if (e.code !== 'not-found') throw e
  }
}

module.exports = {
  PROTOCOL,
  GatewayError,
  GatewayUnavailable,
  socketPath,
  clientName,
  recordId,
  hello,
  add,
  rekey,
  remove,
  removeIfPresent,
  list,
  stats,
}
