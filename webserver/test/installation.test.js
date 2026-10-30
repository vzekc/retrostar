const fs = require('fs')
const os = require('os')
const path = require('path')
const util = require('util')
const execFile = util.promisify(require('child_process').execFile)
const supertest = require('supertest')
const { expect } = require('chai')
const db = require('../src/db')
const app = require('../src/app')

const server = app.callback()

const query = async (sql, params) =>
  db.withClient(async (client) => (await client.query(sql, params)).rows)

const login = async (name) => {
  await query('INSERT INTO "user" (name) VALUES ($1)', [name])
  await query('SELECT set_password($1, $2)', [name, name])
  const agent = supertest.agent(server)
  await agent.post('/auth/login').send({ username: name, password: name })
  return agent
}

// A CA laid out like ca/new-ca.sh does, signing with the repository's ca.cnf.
const makeCa = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrostar-ca-'))
  fs.copyFileSync(
    path.join(__dirname, '..', '..', 'ca', 'ca.cnf'),
    path.join(dir, 'ca.cnf')
  )
  fs.mkdirSync(path.join(dir, 'data'))
  await execFile(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      'data/ca.key',
      '-out',
      'data/ca.crt',
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=RetroStar Test CA',
    ],
    { cwd: dir }
  )
  fs.writeFileSync(path.join(dir, 'data', 'ta.key'), 'test ta key\n')
  fs.writeFileSync(path.join(dir, 'data', 'index.txt'), '')
  fs.writeFileSync(path.join(dir, 'data', 'serial'), '000004AA\n')
  return dir
}

describe('installation', () => {
  let caDir

  before(async () => {
    caDir = await makeCa()
    process.env.OPENVPN_CA_DIR = caDir
  })

  after(() => {
    delete process.env.OPENVPN_CA_DIR
    if (caDir) fs.rmSync(caDir, { recursive: true, force: true })
  })

  it('offers a member without access to set it up', async () => {
    const agent = await login('instnew')
    const response = await agent.get('/installation')
    expect(response.status).to.equal(200)
    expect(response.text).to.contain('Zugang einrichten')
    expect(response.text).not.to.contain('curl -fsSL')
  })

  it('sets up a member’s access', async () => {
    const agent = await login('instmember')
    const post = await agent.post('/installation')
    expect(post.status).to.equal(302)
    expect(post.headers.location).to.equal('/installation')

    const [configuration] = await query(
      `SELECT oc.install_key, oc.certificate, oc.port_number
       FROM openvpn_configuration oc JOIN "user" u ON u.id = oc.user_id
       WHERE u.name = 'instmember'`
    )
    expect(configuration.certificate).to.contain('BEGIN CERTIFICATE')
    const { stdout } = await execFile('openssl', [
      'x509',
      '-noout',
      '-subject',
      '-in',
      path.join(caDir, 'data', 'instmember.crt'),
    ])
    expect(stdout).to.match(/CN\s*=\s*instmember/)
    expect(fs.existsSync(path.join(caDir, 'data', 'servers-changed'))).to.equal(
      true
    )

    const page = await agent.get('/installation')
    expect(page.text).to.contain(configuration.install_key)
    expect(page.text).not.to.contain('Zugang einrichten')

    const config = await supertest(server).get(
      `/client-config/${configuration.install_key}`
    )
    expect(config.status).to.equal(200)
    expect(config.text).to.contain(
      `remote retrostar.classic-computing.de ${configuration.port_number}`
    )
    expect(config.text).to.contain('test ta key')
  })

  it('keeps an existing configuration', async () => {
    const agent = await login('instagain')
    await agent.post('/installation')
    await agent.post('/installation')
    const rows = await query(
      `SELECT 1 FROM openvpn_configuration oc JOIN "user" u ON u.id = oc.user_id
       WHERE u.name = 'instagain'`
    )
    expect(rows).to.have.length(1)
  })

  it('leaves names that are no certificate name to an administrator', async () => {
    const agent = await login('inst odd')
    const page = await agent.get('/installation')
    expect(page.text).to.contain('wende Dich im Forum')
    expect(page.text).not.to.contain('Zugang einrichten')
    const post = await agent.post('/installation')
    expect(post.status).to.equal(400)
  })

  it('sends visitors who are not logged in to the login', async () => {
    const response = await supertest(server).post('/installation')
    expect(response.status).to.equal(302)
    expect(response.headers.location).to.match(/^\/login/)
  })
})
