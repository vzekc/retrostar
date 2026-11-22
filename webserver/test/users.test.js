const fs = require('fs')
const supertest = require('supertest')
const { expect } = require('chai')
const db = require('../src/db')
const app = require('../src/app')
const { makeCa } = require('./fixtures/ca')
const fakeForum = require('./fixtures/fakeForum')

const server = app.callback()

const query = async (sql, params) =>
  db.withClient(async (client) => (await client.query(sql, params)).rows)

const login = async (name, { admin = false } = {}) => {
  await query('INSERT INTO "user" (name, is_admin) VALUES ($1, $2)', [
    name,
    admin,
  ])
  await query('SELECT set_password($1, $2)', [name, name])
  const agent = supertest.agent(server)
  await agent.post('/auth/login').send({ username: name, password: name })
  return agent
}

const userState = async (name) =>
  (
    await query(
      `SELECT u.password_reset_key,
              u.password_reset_key_expires_at > NOW() + INTERVAL '6 days'
                AS long_lived,
              u.forum_nickname,
              u.email,
              COUNT(oc.user_id)::int AS configurations
       FROM "user" u LEFT JOIN openvpn_configuration oc ON oc.user_id = u.id
       WHERE u.name = $1
       GROUP BY u.id`,
      [name]
    )
  )[0]

const configurationNames = async (name) =>
  (
    await query(
      `SELECT COALESCE(oc.config_name, u.name) AS name
       FROM openvpn_configuration oc JOIN "user" u ON u.id = oc.user_id
       WHERE u.name = $1 ORDER BY 1`,
      [name]
    )
  ).map(({ name }) => name)

const revoked = (caDir, name) =>
  new RegExp(`^R\\t.*CN=${name.replace('.', '\\.')}$`, 'm').test(
    fs.readFileSync(`${caDir}/data/index.txt`, 'utf8')
  )

describe('user management', () => {
  let caDir
  let admin
  let forum

  before(async () => {
    caDir = await makeCa()
    process.env.OPENVPN_CA_DIR = caDir
    forum = await fakeForum.start({
      secret: 'test secret',
      users: ['UsersNew', 'UsersPartial', 'UsersGone'],
    })
    process.env.FORUM_MESSAGE_URL = forum.url
    process.env.FORUM_MESSAGE_SECRET = 'test secret'
    admin = await login('usersadmin', { admin: true })
  })

  after(async () => {
    delete process.env.OPENVPN_CA_DIR
    delete process.env.FORUM_MESSAGE_URL
    delete process.env.FORUM_MESSAGE_SECRET
    await forum.close()
    if (caDir) fs.rmSync(caDir, { recursive: true, force: true })
  })

  const setUp = (form) => admin.post('/users').type('form').send(form)

  it('is closed to members who are no administrators', async () => {
    const member = await login('usersmember')
    expect((await member.get('/users')).status).to.equal(403)
    expect(
      (
        await member
          .post('/users')
          .type('form')
          .send({ forum_nickname: 'UsersIntruder' })
      ).status
    ).to.equal(403)
    expect(await userState('usersintruder')).to.equal(undefined)
  })

  describe('setup', () => {
    it('sets up a forum user and sends them a conversation', async () => {
      const post = await setUp({ forum_nickname: 'UsersNew' })
      expect(post.status).to.equal(302)
      const location = new URL(post.headers.location, 'http://x')
      expect(location.searchParams.get('user')).to.equal('usersnew')
      expect(location.searchParams.get('sent')).to.equal('conversation')

      const state = await userState('usersnew')
      expect(state.forum_nickname).to.equal('UsersNew')
      expect(state.configurations).to.equal(1)
      expect(state.long_lived).to.equal(true)
      expect(fs.existsSync(`${caDir}/data/usersnew.crt`)).to.equal(true)

      const message = forum.messages.at(-1)
      expect(message.sender).to.equal('usersadmin')
      expect(message.recipient).to.deep.equal({ username: 'UsersNew' })
      expect(message.message).to.contain(
        `/set-password?key=${state.password_reset_key}`
      )
      expect(message.message).to.contain('Dein Benutzername ist usersnew')

      const page = await admin.get(post.headers.location)
      expect(page.status).to.equal(200)
      expect(page.text).to.contain('als Konversation im Forum an UsersNew')
      expect(page.text).to.contain('Konversation öffnen')
    })

    it('sends an email to a user without forum account', async () => {
      const post = await setUp({
        username: 'usersmail',
        email: 'mail@example.org',
      })
      expect(
        new URL(post.headers.location, 'http://x').searchParams.get('sent')
      ).to.equal('email')
      expect(forum.messages.at(-1).recipient).to.deep.equal({
        email: 'mail@example.org',
      })
      expect((await userState('usersmail')).email).to.equal('mail@example.org')
    })

    it('falls back to email when the forum does not know the nickname', async () => {
      await setUp({
        forum_nickname: 'UsersUnknown',
        email: 'unknown@example.org',
      })
      expect(forum.messages.at(-1).recipient).to.deep.equal({
        email: 'unknown@example.org',
      })
    })

    it('shows the message when it cannot be sent', async () => {
      const post = await setUp({ forum_nickname: 'UsersNowhere' })
      const location = new URL(post.headers.location, 'http://x')
      expect(location.searchParams.get('failed')).to.equal('unknown-recipient')
      const page = await admin.get(post.headers.location)
      expect(page.text).to.contain('Das Forum kennt den Forennamen nicht')
      expect(page.text).to.contain('Dein Benutzername ist usersnowhere')
    })

    it('requires a forum nickname or an email address', async () => {
      const post = await setUp({ username: 'usersnocontact' })
      expect(post.status).to.equal(400)
      expect(await userState('usersnocontact')).to.equal(undefined)
    })

    it('requires a user name when the nickname is none', async () => {
      const post = await setUp({ forum_nickname: 'Users Odd Name' })
      expect(post.status).to.equal(400)
      expect(post.text).to.contain('gib einen Benutzernamen an')
    })

    it('refuses a forum nickname of another user', async () => {
      const post = await setUp({
        username: 'usersdup',
        forum_nickname: 'usersnew',
      })
      expect(post.status).to.equal(400)
      expect(await userState('usersdup')).to.equal(undefined)
    })

    it('completes the setup of an existing user', async () => {
      await query('INSERT INTO "user" (name) VALUES ($1)', ['userspartial'])
      await setUp({ forum_nickname: 'UsersPartial' })
      await setUp({ forum_nickname: 'UsersPartial' })
      const state = await userState('userspartial')
      expect(state.configurations).to.equal(1)
      expect(state.forum_nickname).to.equal('UsersPartial')
    })

    it('sends the account data again with a new link', async () => {
      const before = (await userState('usersnew')).password_reset_key
      const post = await admin.post('/users/usersnew/password-link')
      expect(post.status).to.equal(302)
      const after = (await userState('usersnew')).password_reset_key
      expect(after).not.to.equal(before)
      expect(forum.messages.at(-1).message).to.contain(after)
    })

    it('changes the contact details', async () => {
      await admin
        .post('/users/usersmail/contact')
        .type('form')
        .send({ forum_nickname: 'UsersMail', email: 'new@example.org' })
      const state = await userState('usersmail')
      expect(state.forum_nickname).to.equal('UsersMail')
      expect(state.email).to.equal('new@example.org')
    })
  })

  describe('clients', () => {
    it('adds and removes a client', async () => {
      const add = await admin
        .post('/users/usersnew/clients')
        .type('form')
        .send({ name: 'usersnew-2' })
      expect(add.status).to.equal(302)
      expect(await configurationNames('usersnew')).to.deep.equal([
        'usersnew',
        'usersnew-2',
      ])
      fs.rmSync(`${caDir}/data/servers-changed`, { force: true })

      const remove = await admin.post(
        '/users/usersnew/clients/usersnew-2/delete'
      )
      expect(remove.status).to.equal(302)
      expect(await configurationNames('usersnew')).to.deep.equal(['usersnew'])
      expect(revoked(caDir, 'usersnew-2')).to.equal(true)
      expect(revoked(caDir, 'usersnew')).to.equal(false)
      expect(fs.existsSync(`${caDir}/data/servers-changed`)).to.equal(true)
    })

    it('gives a user without client one of their own name', async () => {
      await query('INSERT INTO "user" (name) VALUES ($1)', ['usersbare2'])
      await admin
        .post('/users/usersbare2/clients')
        .type('form')
        .send({ name: 'usersbare2' })
      const [row] = await query(
        `SELECT oc.config_name FROM openvpn_configuration oc
         JOIN "user" u ON u.id = oc.user_id WHERE u.name = 'usersbare2'`
      )
      expect(row.config_name).to.equal(null)
    })

    it('refuses a client name that is taken', async () => {
      for (const name of ['usersnew', 'usersmail', 'bad name']) {
        const post = await admin
          .post('/users/userspartial/clients')
          .type('form')
          .send({ name })
        expect(post.status, name).to.equal(400)
      }
      expect(await configurationNames('userspartial')).to.deep.equal([
        'userspartial',
      ])
    })

    it('refuses a user named like a client', async () => {
      await admin
        .post('/users/userspartial/clients')
        .type('form')
        .send({ name: 'usersclientname' })
      const post = await setUp({
        username: 'usersclientname',
        email: 'c@example.org',
      })
      expect(post.status).to.equal(400)
      expect(await userState('usersclientname')).to.equal(undefined)
    })

    it('answers 404 for an unknown client', async () => {
      const post = await admin.post('/users/usersnew/clients/nothere/delete')
      expect(post.status).to.equal(404)
    })
  })

  describe('deletion', () => {
    const remove = (agent, name) =>
      agent.post(`/users/${encodeURIComponent(name)}/delete`)

    it('deletes a user with everything they own', async () => {
      const member = await login('usersgone')
      await setUp({ forum_nickname: 'UsersGone' })
      await admin
        .post('/users/usersgone/clients')
        .type('form')
        .send({ name: 'usersgone-2' })
      const [{ id }] = await query(
        `SELECT id FROM "user" WHERE name = 'usersgone'`
      )
      await query(
        `INSERT INTO decnet_block (user_id, start_node, end_node)
         VALUES ($1, 900, 909)`,
        [id]
      )
      await query(
        `INSERT INTO host (user_id, mac_address) VALUES ($1, '02:00:00:00:00:99')`,
        [id]
      )
      fs.rmSync(`${caDir}/data/servers-changed`, { force: true })

      const post = await remove(admin, 'usersgone')
      expect(post.status).to.equal(302)
      expect(post.headers.location).to.equal('/users?deleted=usersgone')

      expect(await userState('usersgone')).to.equal(undefined)
      expect(
        await query(`SELECT 1 FROM decnet_block WHERE start_node = 900`)
      ).to.have.length(0)
      expect(
        await query(
          `SELECT 1 FROM host WHERE mac_address = '02:00:00:00:00:99'`
        )
      ).to.have.length(0)
      expect(revoked(caDir, 'usersgone')).to.equal(true)
      expect(revoked(caDir, 'usersgone-2')).to.equal(true)
      expect(fs.readFileSync(`${caDir}/data/crl.pem`, 'utf8')).to.contain(
        'BEGIN X509 CRL'
      )
      expect(fs.existsSync(`${caDir}/data/servers-changed`)).to.equal(true)

      expect((await admin.get(post.headers.location)).text).to.contain(
        'usersgone wurde gelöscht'
      )
      const page = await member.get('/installation')
      expect(page.status).to.equal(302)
      expect(page.headers.location).to.match(/^\/login/)
    })

    it('deletes a user without VPN access', async () => {
      await query('INSERT INTO "user" (name) VALUES ($1)', ['usersbare'])
      expect((await remove(admin, 'usersbare')).status).to.equal(302)
      expect(await userState('usersbare')).to.equal(undefined)
    })

    it('refuses to delete the administrator themselves', async () => {
      expect((await remove(admin, 'usersadmin')).status).to.equal(400)
      expect(await userState('usersadmin')).to.not.equal(undefined)
    })

    it('answers 404 for an unknown user', async () => {
      expect((await remove(admin, 'usersnobody')).status).to.equal(404)
    })

    it('is closed to members who are no administrators', async () => {
      await query('INSERT INTO "user" (name) VALUES ($1)', ['userskept'])
      const member = await login('usersmember2')
      expect((await remove(member, 'userskept')).status).to.equal(403)
      expect(await userState('userskept')).to.not.equal(undefined)
    })
  })
})
