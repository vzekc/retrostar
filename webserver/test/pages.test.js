const supertest = require('supertest')
const { expect } = require('chai')
const db = require('../src/db')
const app = require('../src/app')

const server = app.callback()

describe('pages', () => {
  it('serves the login page', async () => {
    const response = await supertest(server).get('/login')
    expect(response.status).to.equal(200)
    expect(response.text).to.contain('loginForm')
  })

  it('answers 404 for a path below the login page', async () => {
    const response = await supertest(server).get('/login/hostinfo.cgi')
    expect(response.status).to.equal(404)
  })

  it('answers 404 for a path below a page that needs a login', async () => {
    const response = await supertest(server).get('/installation/x')
    expect(response.status).to.equal(404)
  })

  it('serves a host’s page', async () => {
    await db.withClient(async (client) => {
      await client.query(`INSERT INTO "user" (name) VALUES ('pagesowner')`)
      await client.query(
        `INSERT INTO host (user_id, mac_address, last_seen)
         VALUES ((SELECT id FROM "user" WHERE name = 'pagesowner'),
                 'aa:00:04:00:14:5c', NOW())`
      )
    })
    const response = await supertest(server).get('/hostinfo/aa:00:04:00:14:5c')
    expect(response.status).to.equal(200)
  })

  it('answers 404 for an unknown host', async () => {
    const response = await supertest(server).get('/hostinfo/aa:00:04:00:15:5c')
    expect(response.status).to.equal(404)
  })

  it('answers 404 for the host page without a host', async () => {
    const response = await supertest(server).get('/hostinfo')
    expect(response.status).to.equal(404)
  })

  it('serves the DECnet page to visitors', async () => {
    const response = await supertest(server).get('/decnet')
    expect(response.status).to.equal(200)
    expect(response.text).to.contain('decnet.js')
  })
})
