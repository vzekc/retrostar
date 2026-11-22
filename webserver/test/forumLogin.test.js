const { expect } = require('chai')
const passport = require('koa-passport')
const db = require('../src/db')
require('../src/app')

// Runs the OIDC strategy's verify callback with the forum's claims.
const forumLogin = (claims) =>
  new Promise((resolve, reject) => {
    passport
      ._strategy('oidc')
      ._verify(
        null,
        { _json: claims },
        null,
        null,
        null,
        null,
        null,
        null,
        (err, user, info) => (err ? reject(err) : resolve({ user, info }))
      )
  })

describe('forum login', () => {
  it('gives a member logging in for the first time a user record', async () => {
    const { user } = await forumLogin({
      nickname: 'FirstTimer',
      rank: 'Vereinsmitglied',
    })
    expect(user.username).to.equal('firsttimer')
    expect(user.id).to.equal(await db.getUserId('firsttimer'))
    expect(user.id).to.be.a('string')
  })

  it('keeps the user record of a returning member', async () => {
    const first = await forumLogin({ nickname: 'Returner', rank: 'Vorstand' })
    const second = await forumLogin({ nickname: 'Returner', rank: 'Vorstand' })
    expect(second.user.id).to.equal(first.user.id)
    expect(second.user.is_admin).to.equal(true)
  })

  it('turns away forum users who are not members', async () => {
    const { user } = await forumLogin({ nickname: 'Guest', rank: 'Gast' })
    expect(user).to.equal(false)
    expect(await db.getUserId('guest')).to.equal(undefined)
  })

  it('records the forum nickname and email address', async () => {
    await forumLogin({
      nickname: 'Recorded',
      email: 'recorded@example.org',
      rank: 'Vereinsmitglied',
    })
    const [user] = await db.withClient(async (client) =>
      db.getUsers(client, { name: 'recorded' })
    )
    expect(user.forum_nickname).to.equal('Recorded')
    expect(user.email).to.equal('recorded@example.org')
  })

  it('logs in the user an administrator set up for the forum account', async () => {
    await db.withClient((client) =>
      client.query(
        `INSERT INTO "user" (name, forum_nickname) VALUES ('setupname', 'Set Up Nick')`
      )
    )
    const { user } = await forumLogin({
      nickname: 'Set Up Nick',
      rank: 'Gast',
    })
    expect(user.username).to.equal('setupname')
  })

  it('turns away a forum account whose name belongs to another', async () => {
    await db.withClient((client) =>
      client.query(
        `INSERT INTO "user" (name, forum_nickname) VALUES ('taken', 'Someone Else')`
      )
    )
    const { user } = await forumLogin({ nickname: 'Taken', rank: 'Vorstand' })
    expect(user).to.equal(false)
  })
})
