const supertest = require('supertest')
const { expect } = require('chai')
const db = require('../src/db')
const app = require('../src/app')
const path = require('node:path')

const server = app.callback()
const request = supertest.agent(server)

describe('Article and Image CRUD Test', () => {
  let articleId
  const username = 'test'
  const password = 'test'

  before(async () => {
    await db.withClient(async (client) => {
      await client.query('DELETE FROM "user" WHERE name = $1', [username])
      await client.query('INSERT INTO "user"(name) values($1)', [username])
      await client.query('SELECT set_password($1, $2)', [username, password])
    })
    const result = await request
      .post('/auth/login')
      .send({ username, password })
  })

  it('should create a new article', async () => {
    const response = await request
      .post('/api/article')
      .send({ content: 'Test article content' })

    expect(response.status).to.equal(201)
    expect(response.body).to.have.property('id')

    articleId = response.body.id
  })

  it('should confirm the article can be read', async () => {
    const response = await request.get(`/api/article/${articleId}`)

    expect(response.status).to.equal(200)
  })

  it('should delete the article', async () => {
    const response = await request.delete(`/api/article/${articleId}`)

    expect(response.status).to.equal(204)
  })

  it('should confirm the article was deleted', async () => {
    const response = await request.get(`/api/article/${articleId}`)

    expect(response.status).to.equal(404)
  })
})
