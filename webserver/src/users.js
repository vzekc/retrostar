// User management by administrators: setting up users with their OpenVPN
// configuration and password link, sending them the account message
// through the forum, adding and removing their OpenVPN clients, and deleting
// users with everything they own.

const db = require('./db')
const event = require('./event')
const forum = require('./forum')
const gatewayClients = require('./gatewayClients')
const openvpnConfigurations = require('./openvpnConfigurations')
const { SUBJECT, accountMessage } = require('./accountMessage')

// Administrators send the password link by forum conversation or email.
const PASSWORD_LINK_VALIDITY = '7 days'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

class UserError extends Error {}

// Validates the contact details of a form: forum nickname and email address,
// at least one of them. Answers them trimmed, absent ones as null.
const contact = ({ forum_nickname, email }) => {
  const nickname = String(forum_nickname || '').trim() || null
  const address = String(email || '').trim() || null
  if (!nickname && !address) {
    throw new UserError('Gib den Forennamen oder die E-Mail-Adresse an.')
  }
  if (nickname && nickname.length > 100) {
    throw new UserError('Der Forenname ist zu lang.')
  }
  if (address && !EMAIL_PATTERN.test(address)) {
    throw new UserError(`${address} ist keine E-Mail-Adresse.`)
  }
  return { forumNickname: nickname, email: address }
}

const setContact = async (client, username, { forumNickname, email }) => {
  await client.query('SAVEPOINT contact')
  try {
    await client.query(
      `UPDATE "user" SET forum_nickname = $2, email = $3 WHERE name = $1`,
      [username, forumNickname, email]
    )
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT contact')
    if (e.code === '23505') {
      throw new UserError(
        `Der Forenname ${forumNickname} gehört schon zu einem anderen Benutzer.`
      )
    }
    throw e
  }
}

// The user name of a new user: the one given or, without one, the forum
// nickname in lower case.
const usernameFor = (username, forumNickname) => {
  const name = String(username || '')
    .trim()
    .toLowerCase()
  const derived = name || (forumNickname || '').toLowerCase()
  if (!openvpnConfigurations.canSelfIssue(derived)) {
    throw new UserError(
      name
        ? 'Der Benutzername besteht aus Kleinbuchstaben, Ziffern, ".", "_" und "-" und beginnt mit einem Buchstaben oder einer Ziffer.'
        : `Der Forenname ${forumNickname} eignet sich nicht als Benutzername; gib einen Benutzernamen an.`
    )
  }
  return derived
}

// Sends the account message with a new password link to the user named
// username: as a forum conversation when they have a forum nickname,
// otherwise, or when the forum does not know the nickname, by email.
// Answers { via, link } on success, { error, message } otherwise.
const sendAccountMessage = async (admin, username) => {
  await db.withClient((client) =>
    db.requestPasswordReset(client, username, PASSWORD_LINK_VALIDITY)
  )
  const [user] = await db.withClient((client) =>
    db.getUsers(client, { name: username })
  )
  const message = {
    sender: admin.username,
    subject: SUBJECT,
    message: accountMessage(user),
  }
  let answer = { ok: false, error: 'no-contact' }
  if (user.forum_nickname) {
    answer = await forum.sendMessage({
      ...message,
      recipient: { username: user.forum_nickname },
    })
  }
  if (!answer.ok && answer.error !== 'not-configured' && user.email) {
    answer = await forum.sendMessage({
      ...message,
      recipient: { email: user.email },
    })
  }
  if (!answer.ok) {
    console.log('account message to', username, 'failed:', answer)
    return { error: answer.error, message: answer.message }
  }
  await event.publish(
    'user',
    `${admin.username} hat ${username} die Zugangsdaten geschickt`,
    { username }
  )
  return { via: answer.via, link: answer.link }
}

// Creates the user, their OpenVPN configuration and sends them the account
// message. Each step keeps what already exists, so setting up a user again
// completes a partial setup. Answers the user name and the delivery of the
// message.
const setUp = async (admin, form) => {
  const details = contact(form)
  const username = usernameFor(form.username, details.forumNickname)
  const existed = !!(await db.getUserId(username))
  if (
    !existed &&
    (await db.withClient((client) =>
      openvpnConfigurations.nameTaken(client, username)
    ))
  ) {
    throw new UserError(
      `Der Name ${username} gehört schon zu einem VPN-Zugang.`
    )
  }
  const owner = details.forumNickname
    ? await db.findForumUser(details.forumNickname)
    : null
  if (owner && (owner.conflict || owner.name !== username)) {
    throw new UserError(
      `Der Forenname ${details.forumNickname} gehört schon zu einem anderen Benutzer.`
    )
  }
  const id = await db.ensureUserId(username)
  await db.withClient((client) => setContact(client, username, details))
  await openvpnConfigurations.createConfiguration({ id, username })
  if (!existed) {
    await event.publish(
      'user',
      `${admin.username} hat den Benutzer ${username} angelegt`,
      { username }
    )
  }
  return { username, delivery: await sendAccountMessage(admin, username) }
}

const updateContact = async (client, username, form) =>
  setContact(client, username, contact(form))

// Adds the OpenVPN client name to the user named username.
const addClient = async (admin, username, name) => {
  const id = await db.getUserId(username)
  if (!id) return false
  const clientName = String(name || '')
    .trim()
    .toLowerCase()
  try {
    await openvpnConfigurations.addClient({ id, username }, clientName)
  } catch (e) {
    if (e instanceof openvpnConfigurations.NameTaken) {
      throw new UserError(e.message)
    }
    throw e
  }
  await event.publish(
    'openvpn-configuration',
    `${admin.username} hat ${username} den VPN-Zugang ${clientName} eingerichtet`,
    { username }
  )
  return true
}

// Deletes the OpenVPN configurations of userId matching condition and
// revokes their certificates. A failed revocation rolls the deletion back.
const deleteConfigurations = async (client, condition, params) => {
  const deleted = await client.query(
    `DELETE FROM openvpn_configuration oc USING "user" u
     WHERE u.id = oc.user_id AND ${condition}
     RETURNING oc.certificate`,
    params
  )
  const certificates = deleted.rows.map(({ certificate }) => certificate)
  await openvpnConfigurations.revokeCertificates(certificates)
  return certificates.length
}

// Removes the OpenVPN client name of the user named username and revokes its
// certificate; its server stops. Answers false when the user has no such
// client.
const removeClient = async (admin, username, name) => {
  const removed = await db.withClient((client) =>
    deleteConfigurations(
      client,
      'u.name = $1 AND COALESCE(oc.config_name, u.name) = $2',
      [username, name]
    )
  )
  if (!removed) return false
  openvpnConfigurations.signalServers()
  await event.publish(
    'openvpn-configuration',
    `${admin.username} hat den VPN-Zugang ${name} von ${username} entfernt`,
    { username }
  )
  return true
}

// Deletes the user named username: revokes their DECnet gateway clients,
// releases their DECnet blocks, deletes their hosts and OpenVPN
// configurations and revokes the configurations' certificates. A failed
// revocation rolls the deletion back; deleting again revokes what is left.
// Once the deletion is committed, the OpenVPN servers of the configurations
// stop. Answers false for an unknown user.
const remove = async (admin, username) => {
  const configurations = await db.withClient(async (client) => {
    const user = (
      await client.query(`SELECT id FROM "user" WHERE name = $1 FOR UPDATE`, [
        username,
      ])
    ).rows[0]
    if (!user) return null
    const reason = `Benutzer ${username} gelöscht`

    const blocks = await client.query(
      `SELECT id FROM decnet_block WHERE user_id = $1`,
      [user.id]
    )
    for (const { id } of blocks.rows) {
      await gatewayClients.revokeBlockClients(client, id, admin.id, reason)
      await gatewayClients.detachRevokedFromBlock(client, id)
    }
    const clients = await client.query(
      `SELECT id FROM decnet_gateway_client
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id]
    )
    for (const { id } of clients.rows) {
      await gatewayClients.revokeClient(client, admin, id, reason)
    }
    await client.query(`DELETE FROM decnet_block WHERE user_id = $1`, [user.id])
    await client.query(`DELETE FROM host WHERE user_id = $1`, [user.id])
    const count = await deleteConfigurations(client, 'u.id = $1', [user.id])
    await client.query(`DELETE FROM "user" WHERE id = $1`, [user.id])
    return count
  })
  if (configurations === null) return false

  if (configurations) {
    openvpnConfigurations.signalServers()
  }
  await event.publish(
    'user',
    `${admin.username} hat den Benutzer ${username} gelöscht`,
    { username }
  )
  return true
}

module.exports = {
  UserError,
  setUp,
  sendAccountMessage,
  updateContact,
  addClient,
  removeClient,
  remove,
}
