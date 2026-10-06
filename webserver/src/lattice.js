// Talks to latticed's user socket: lists the LAT services and brings web
// users to its Local> prompt. A request is one line of JSON; after a login
// request the connection carries the user's terminal.

const net = require('net')

const socketPath = process.env.LATTICE_SOCKET || '/run/latticed/users.sock'

const IAC = 0xff

// The input that sends a BREAK, which returns the user to Local>.
const BREAK = Buffer.from([IAC, 0xf3])

const request = (req) => {
  const socket = net.createConnection(socketPath)
  socket.write(JSON.stringify(req) + '\n')
  return socket
}

// The LAT services latticed knows, as { name, description, available }.
const getServices = () =>
  new Promise((resolve, reject) => {
    const socket = request({ request: 'services' })
    const chunks = []
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()))
      } catch (e) {
        reject(e)
      }
    })
  })

// Opens a session at the Local> prompt; options are those of latticed's
// login request (name, source, terminal, type, width, height, connect).
const login = (options) => request({ request: 'login', ...options })

// Typed input as latticed takes it, where 0xFF introduces a command and
// stands for itself doubled.
const escapeInput = (data) => {
  const bytes = Buffer.from(data)
  if (!bytes.includes(IAC)) {
    return bytes
  }
  const out = []
  for (const b of bytes) {
    out.push(b)
    if (b === IAC) {
      out.push(IAC)
    }
  }
  return Buffer.from(out)
}

module.exports = { getServices, login, escapeInput, BREAK }
