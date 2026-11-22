// Client of the forum's RetroStar message endpoint (WoltLab package
// de.classic-computing.retrostar-message): the forum sends a message as a
// conversation to a forum user or as an email. Requests are signed with
// HMAC-SHA256 over "<timestamp>.<body>" with the shared secret.
//
// FORUM_MESSAGE_URL is the endpoint, e.g.
// https://forum.classic-computing.de/retrostar-message/send.php;
// FORUM_MESSAGE_SECRET the secret set in the forum's ACP.

const crypto = require('crypto')

const configured = () =>
  !!(process.env.FORUM_MESSAGE_URL && process.env.FORUM_MESSAGE_SECRET)

// Sends subject and message from the forum user sender to recipient, which
// is { username } or { email }. Answers the endpoint's answer:
// { ok: true, via, link? } or { ok: false, error, message? }.
const sendMessage = async ({ sender, recipient, subject, message }) => {
  if (!configured()) {
    return { ok: false, error: 'not-configured' }
  }
  const body = JSON.stringify({ sender, recipient, subject, message })
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = crypto
    .createHmac('sha256', process.env.FORUM_MESSAGE_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex')
  try {
    const response = await fetch(process.env.FORUM_MESSAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RetroStar-Timestamp': timestamp,
        'X-RetroStar-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(20000),
    })
    const answer = await response.json().catch(() => null)
    return answer && typeof answer.ok === 'boolean'
      ? answer
      : { ok: false, error: 'failed', message: `HTTP ${response.status}` }
  } catch (e) {
    return { ok: false, error: 'unreachable', message: e.message }
  }
}

module.exports = { configured, sendMessage }
