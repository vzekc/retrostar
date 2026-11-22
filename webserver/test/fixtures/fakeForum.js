// The forum's RetroStar message endpoint, for tests: checks the signature,
// opens conversations to the forum users it knows and accepts any email.

const http = require('http')
const crypto = require('crypto')

const start = async ({ secret, users = [] }) => {
  const state = {
    messages: [],
    users: new Set(users.map((u) => u.toLowerCase())),
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const answer = (status, json) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(json))
      }
      const timestamp = req.headers['x-retrostar-timestamp']
      const expected = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex')
      if (req.headers['x-retrostar-signature'] !== expected) {
        return answer(401, { ok: false, error: 'bad-signature' })
      }
      const message = JSON.parse(body)
      if (message.recipient.username) {
        if (!state.users.has(message.recipient.username.toLowerCase())) {
          return answer(404, { ok: false, error: 'unknown-recipient' })
        }
        state.messages.push(message)
        return answer(200, {
          ok: true,
          via: 'conversation',
          link: `${state.origin}/index.php?conversation/${state.messages.length}/`,
        })
      }
      state.messages.push(message)
      answer(200, { ok: true, via: 'email' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.origin = `http://127.0.0.1:${server.address().port}`
  state.url = `${state.origin}/retrostar-message/send.php`
  state.close = () => new Promise((resolve) => server.close(resolve))
  return state
}

module.exports = { start }
