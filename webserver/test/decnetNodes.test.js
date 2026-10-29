const supertest = require('supertest')
const { expect } = require('chai')
const db = require('../src/db')
const app = require('../src/app')

const server = app.callback()

describe('DECnet node list', () => {
  it('lists the named nodes to anyone', async () => {
    await db.withClient((client) =>
      client.query(
        `INSERT INTO "user" (name) VALUES ('nodesowner');
         SELECT set_password('nodesowner', 'nodesowner')`
      )
    )
    const owner = supertest.agent(server)
    await owner
      .post('/auth/login')
      .send({ username: 'nodesowner', password: 'nodesowner' })
    const block = (await owner.post('/api/decnet/blocks')).body
    const named = await owner
      .put(`/api/decnet/hosts/${block.start_node}`)
      .send({ name: 'NODEA' })
    expect(named.status).to.equal(200)

    const response = await supertest(server).get('/api/decnet/nodes')
    expect(response.status).to.equal(200)
    expect(response.body).to.deep.include({
      address: `23.${block.start_node}`,
      name: 'NODEA',
    })
    const addresses = response.body.map(({ address }) => address)
    expect(addresses).to.not.include(`23.${block.start_node + 1}`)
  })
})
