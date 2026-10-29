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
})
