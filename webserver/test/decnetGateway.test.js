const supertest = require('supertest')
const { expect } = require('chai')
const db = require('../src/db')
const app = require('../src/app')
const gatewayClients = require('../src/gatewayClients')
const bridgeInfo = require('../src/bridgeInfo')
const fakeGateway = require('./fixtures/fakeGateway')

const server = app.callback()

const query = async (sql, params) =>
  db.withClient(async (client) => (await client.query(sql, params)).rows)

const createUser = async (name, isAdmin = false) => {
  await query('INSERT INTO "user" (name, is_admin) VALUES ($1, $2)', [
    name,
    isAdmin,
  ])
  await query('SELECT set_password($1, $2)', [name, name])
  const agent = supertest.agent(server)
  await agent.post('/auth/login').send({ username: name, password: name })
  return agent
}

const setHost = (owner, nodeNumber, ageDays) =>
  query(
    `INSERT INTO host (user_id, mac_address, last_seen)
     VALUES ((SELECT id FROM "user" WHERE name = $1), decnet_mac($2),
             NOW() - make_interval(days => $3))`,
    [owner, nodeNumber, ageDays]
  )

const events = (type) =>
  query('SELECT message, data FROM event WHERE type = $1 ORDER BY id', [type])

describe('DECnet gateway clients', () => {
  let alice, bob, admin
  let block
  let gw

  before(async () => {
    process.env.DECNET_GATEWAY_SOCKET = '/nonexistent/control.sock'
    alice = await createUser('gwalice')
    bob = await createUser('gwbob')
    admin = await createUser('gwadmin', true)
  })

  after(async () => {
    if (gw) await gw.stop()
  })

  describe('without a gateway', () => {
    it('serves the page', async () => {
      const response = await alice.get('/decnet-gateway')
      expect(response.status).to.equal(200)
      expect(response.text).to.contain('decnet-gateway.js')
    })

    it('lists no nodes and reports the gateway unavailable', async () => {
      const response = await alice.get('/api/decnet/gateway-clients')
      expect(response.status).to.equal(200)
      expect(response.body.gateway.available).to.equal(false)
      expect(response.body.nodes).to.deep.equal([])
      expect(response.body.clients).to.deep.equal([])
    })

    it('refuses a node outside the member’s blocks', async () => {
      const response = await alice
        .post('/api/decnet/gateway-clients')
        .send({ node_number: 20, name: 'XA' })
      expect(response.status).to.equal(403)
    })

    it('answers 503 for a new client and leaves nothing behind', async () => {
      const allocated = await alice.post('/api/decnet/blocks')
      expect(allocated.status).to.equal(201)
      block = allocated.body
      const response = await alice
        .post('/api/decnet/gateway-clients')
        .send({ node_number: block.start_node, name: 'alpha' })
      expect(response.status).to.equal(503)
      expect(await query('SELECT * FROM decnet_gateway_client')).to.be.empty
      expect(
        await query('SELECT * FROM decnet_host WHERE node_number = $1', [
          block.start_node,
        ])
      ).to.be.empty
    })

    it('keeps the DECnet address pages working', async () => {
      expect((await alice.get('/decnet')).status).to.equal(200)
      expect((await alice.get('/api/decnet/blocks')).status).to.equal(200)
    })
  })

  describe('with a gateway', () => {
    let alpha

    before(async () => {
      gw = await fakeGateway.start()
      process.env.DECNET_GATEWAY_SOCKET = gw.socketPath
    })

    it('reports the gateway available and lists the block’s nodes', async () => {
      const response = await alice.get('/api/decnet/gateway-clients')
      expect(response.body.gateway).to.deep.equal({
        available: true,
        version: '0.0.0-test',
      })
      expect(response.body.nodes).to.have.length(10)
      expect(response.body.nodes[0]).to.include({
        node_number: block.start_node,
        address: `23.${block.start_node}`,
        name: null,
        client_id: null,
        host_seen: null,
      })
    })

    it('creates a client, shows its line once and stores no key', async () => {
      const node = block.start_node
      const response = await alice
        .post('/api/decnet/gateway-clients')
        .send({ node_number: node, name: 'alpha' })
      expect(response.status).to.equal(201)
      expect(response.headers['cache-control']).to.equal('no-store')
      alpha = response.body.client
      expect(alpha).to.include({
        name: 'ALPHA',
        address: `23.${node}`,
        node_number: node,
        owner: 'gwalice',
      })
      expect(response.body.line).to.match(
        new RegExp(
          `^DNGW1 \\S+ 26003 ${alpha.key_id} 23\\.${node} [0-9a-f]{64}$`
        )
      )
      expect(response.body.qr_svg).to.contain('<svg')

      const [gatewayClient] = [...gw.state.clients.values()]
      expect(gatewayClient).to.include({
        name: `rs:${alpha.id} gwalice/ALPHA`,
        address: `23.${node}`,
        endnode_only: true,
      })
      expect(alpha.key_fingerprint).to.equal(gatewayClient.fingerprint)

      const [row] = await query(
        'SELECT row_to_json(c)::text AS json FROM decnet_gateway_client c'
      )
      expect(row.json).not.to.contain(gatewayClient.key)
      const [host] = await query(
        'SELECT name FROM decnet_host WHERE node_number = $1',
        [node]
      )
      expect(host.name).to.equal('ALPHA')
    })

    it('lists the member’s client and the node as taken', async () => {
      const response = await alice.get('/api/decnet/gateway-clients')
      expect(response.body.clients.map(({ id }) => id)).to.deep.equal([
        alpha.id,
      ])
      expect(response.body.nodes[0].client_id).to.equal(alpha.id)
    })

    it('refuses a second client on the node', async () => {
      const response = await alice
        .post('/api/decnet/gateway-clients')
        .send({ node_number: block.start_node, name: 'alpha' })
      expect(response.status).to.equal(409)
      expect(response.body.code).to.equal('node-in-use')
    })

    it('refuses a name another node carries', async () => {
      const adds = gw.state.requests.filter(({ op }) => op === 'add').length
      const response = await alice
        .post('/api/decnet/gateway-clients')
        .send({ node_number: block.start_node + 1, name: 'Alpha' })
      expect(response.status).to.equal(409)
      expect(response.body.code).to.equal('name-taken')
      expect(gw.state.requests.filter(({ op }) => op === 'add')).to.have.length(
        adds
      )
    })

    it('refuses an invalid name', async () => {
      const response = await alice
        .post('/api/decnet/gateway-clients')
        .send({ node_number: block.start_node + 1, name: '1abc' })
      expect(response.status).to.equal(400)
    })

    it('asks before moving a machine seen in the last 30 days', async () => {
      const node = block.start_node + 2
      await setHost('gwalice', node, 1)
      const refused = await alice
        .post('/api/decnet/gateway-clients')
        .send({ node_number: node, name: 'moved' })
      expect(refused.status).to.equal(409)
      expect(refused.body.code).to.equal('host-seen')
      expect(refused.body.host_seen.owner).to.equal('gwalice')

      const moved = await alice
        .post('/api/decnet/gateway-clients')
        .send({ node_number: node, name: 'moved', move: true })
      expect(moved.status).to.equal(201)
    })

    it('refuses an address another member’s machine used', async () => {
      const node = block.start_node + 3
      await setHost('gwbob', node, 2)
      const response = await alice
        .post('/api/decnet/gateway-clients')
        .send({ node_number: node, name: 'other', move: true })
      expect(response.status).to.equal(409)
      expect(response.body.code).to.equal('host-of-other-member')
    })

    it('offers a node whose machine was last seen long ago', async () => {
      const node = block.start_node + 4
      await setHost('gwbob', node, 40)
      const response = await alice
        .post('/api/decnet/gateway-clients')
        .send({ node_number: node, name: 'old' })
      expect(response.status).to.equal(201)
    })

    it('passes the gateway’s refusal on and rolls back', async () => {
      const node = block.start_node + 5
      gw.state.failNext.add = 'address-in-use'
      const response = await alice
        .post('/api/decnet/gateway-clients')
        .send({ node_number: node, name: 'taken' })
      expect(response.status).to.equal(409)
      expect(response.body.code).to.equal('address-in-use')
      expect(
        await query('SELECT * FROM decnet_host WHERE node_number = $1', [node])
      ).to.be.empty
    })

    it('removes the key again when the record does not commit', async () => {
      await query(`
        CREATE FUNCTION test_refuse_boom() RETURNS trigger AS $$
        BEGIN
          IF NEW.name = 'BOOM' THEN RAISE 'refused at commit'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE CONSTRAINT TRIGGER test_refuse_boom
          AFTER INSERT OR UPDATE ON decnet_gateway_client
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION test_refuse_boom();`)
      try {
        const response = await alice
          .post('/api/decnet/gateway-clients')
          .send({ node_number: block.start_node + 6, name: 'boom' })
        expect(response.status).to.equal(500)
        const added = gw.state.requests.filter(({ op }) => op === 'add').pop()
        expect(added.name).to.match(/gwalice\/BOOM$/)
        const removed = gw.state.requests.pop()
        expect(removed.op).to.equal('remove')
        expect(
          [...gw.state.clients.values()].map(({ name }) => name)
        ).not.to.include(added.name)
      } finally {
        await query(`
          DROP TRIGGER test_refuse_boom ON decnet_gateway_client;
          DROP FUNCTION test_refuse_boom();`)
      }
    })

    it('rekeys for the owner and the admin, not for others', async () => {
      const before = gw.state.clients.get(alpha.key_id).key
      const response = await alice.post(
        `/api/decnet/gateway-clients/${alpha.id}/rekey`
      )
      expect(response.status).to.equal(200)
      expect(response.headers['cache-control']).to.equal('no-store')
      expect(response.body.line).not.to.contain(before)
      expect(response.body.line).to.contain(
        gw.state.clients.get(alpha.key_id).key
      )
      expect(response.body.qr_svg).to.contain('<svg')
      expect(response.body.client.rekeyed_at).to.be.a('string')

      expect(
        (await bob.post(`/api/decnet/gateway-clients/${alpha.id}/rekey`)).status
      ).to.equal(404)
      expect(
        (await admin.post(`/api/decnet/gateway-clients/${alpha.id}/rekey`))
          .status
      ).to.equal(200)
    })

    it('rekeys at most ten times a day', async () => {
      await query(
        `UPDATE decnet_gateway_client
         SET rekey_count = 10, rekey_day = CURRENT_DATE WHERE id = $1`,
        [alpha.id]
      )
      const response = await alice.post(
        `/api/decnet/gateway-clients/${alpha.id}/rekey`
      )
      expect(response.status).to.equal(429)
      await query(
        `UPDATE decnet_gateway_client
         SET rekey_count = 10, rekey_day = CURRENT_DATE - 1 WHERE id = $1`,
        [alpha.id]
      )
      expect(
        (await alice.post(`/api/decnet/gateway-clients/${alpha.id}/rekey`))
          .status
      ).to.equal(200)
    })

    it('shows the live status to the owner and the admin', async () => {
      gw.state.connected.add(alpha.key_id)
      const response = await alice.get(
        `/api/decnet/gateway-clients/${alpha.id}/status`
      )
      expect(response.status).to.equal(200)
      expect(response.body).to.include({
        known: true,
        connected: true,
        endpoint: '198.51.100.7:51234',
      })
      expect(response.body.drops).to.have.property('replay')
      expect(
        (await admin.get(`/api/decnet/gateway-clients/${alpha.id}/status`))
          .status
      ).to.equal(200)
      expect(
        (await bob.get(`/api/decnet/gateway-clients/${alpha.id}/status`)).status
      ).to.equal(404)
    })

    it('lists every client for the admin with all=1 only', async () => {
      await bob.post('/api/decnet/blocks')
      const bobNodes = (await bob.get('/api/decnet/gateway-clients')).body.nodes
      const created = await bob
        .post('/api/decnet/gateway-clients')
        .send({ node_number: bobNodes[0].node_number, name: 'bobby' })
      expect(created.status).to.equal(201)

      const own = await bob.get('/api/decnet/gateway-clients?all=1')
      expect(own.body.clients.map(({ owner }) => owner)).to.deep.equal([
        'gwbob',
      ])
      const all = await admin.get('/api/decnet/gateway-clients?all=1')
      expect(
        [...new Set(all.body.clients.map(({ owner }) => owner))].sort()
      ).to.deep.equal(['gwalice', 'gwbob'])
    })

    it('records connects and disconnects without endpoints', async () => {
      const poller = gatewayClients.createPoller()
      gw.state.connected.clear()
      await poller.poll()
      gw.state.connected.add(alpha.key_id)
      await poller.poll()
      const [row] = await query(
        'SELECT last_seen FROM decnet_gateway_client WHERE id = $1',
        [alpha.id]
      )
      expect(row.last_seen).to.be.a('date')
      gw.state.connected.delete(alpha.key_id)
      await poller.poll()

      const connects = await events('decnet-gateway-connect')
      const disconnects = await events('decnet-gateway-disconnect')
      expect(connects).to.have.length(1)
      expect(disconnects).to.have.length(1)
      expect(connects[0].data).to.deep.equal({
        username: 'gwalice',
        name: 'ALPHA',
        address: alpha.address,
      })
      for (const { message, data } of [...connects, ...disconnects]) {
        expect(message + JSON.stringify(data)).not.to.contain('198.51.100.7')
      }
    })

    it('keeps the node name while a client uses it', async () => {
      const response = await alice.delete(
        `/api/decnet/hosts/${block.start_node}`
      )
      expect(response.status).to.equal(409)
    })

    it('carries a rename into the client record', async () => {
      const response = await alice
        .put(`/api/decnet/hosts/${block.start_node}`)
        .send({ name: 'ALPHA2' })
      expect(response.status).to.equal(200)
      const [row] = await query(
        'SELECT name FROM decnet_gateway_client WHERE id = $1',
        [alpha.id]
      )
      expect(row.name).to.equal('ALPHA2')
    })

    it('revokes for the owner at once, not for others', async () => {
      expect(
        (await bob.delete(`/api/decnet/gateway-clients/${alpha.id}`)).status
      ).to.equal(404)
      const response = await alice
        .delete(`/api/decnet/gateway-clients/${alpha.id}`)
        .send({ reason: 'verkauft' })
      expect(response.status).to.equal(204)
      expect(gw.state.clients.has(alpha.key_id)).to.equal(false)
      const [row] = await query(
        `SELECT revoked_at, revoke_reason, u.name AS revoked_by
         FROM decnet_gateway_client c JOIN "user" u ON u.id = c.revoked_by
         WHERE c.id = $1`,
        [alpha.id]
      )
      expect(row.revoked_at).to.be.a('date')
      expect(row).to.include({
        revoke_reason: 'verkauft',
        revoked_by: 'gwalice',
      })
      expect(
        (await alice.post(`/api/decnet/gateway-clients/${alpha.id}/rekey`))
          .status
      ).to.equal(404)
    })

    it('releases the node name of a revoked client', async () => {
      const response = await alice.delete(
        `/api/decnet/hosts/${block.start_node}`
      )
      expect(response.status).to.equal(204)
      const [row] = await query(
        'SELECT node_number, address FROM decnet_gateway_client WHERE id = $1',
        [alpha.id]
      )
      expect(row).to.deep.equal({
        node_number: null,
        address: alpha.address,
      })
    })

    it('records machines on the gateway’s port for the client’s owner', async () => {
      const node = block.start_node + 4
      const mac = fakeGateway.decnetMac(`23.${node}`)
      const unknownMac = fakeGateway.decnetMac(`23.${block.start_node + 9}`)
      const nodes = bridgeInfo.parseBridgeNodes(
        [
          `${mac} dev dngw0 master br0 `,
          `${unknownMac} dev dngw0 master br0 `,
          `02:00:00:00:00:01 dev tap7 master br0 `,
          `02:00:00:00:00:02 dev dngw0 master br0 permanent`,
        ].join('\n')
      )
      expect(nodes).to.deep.equal([
        ['dngw0', mac],
        ['dngw0', unknownMac],
        ['tap7', '02:00:00:00:00:01'],
      ])
      await bridgeInfo.updateHosts(nodes, {})
      const hosts = await query(
        `SELECT h.mac_address::text AS mac, u.name AS owner,
                h.last_seen > NOW() - INTERVAL '1 minute' AS fresh
         FROM host h JOIN "user" u ON u.id = h.user_id
         WHERE h.mac_address = ANY($1::macaddr[])`,
        [[mac, unknownMac, '02:00:00:00:00:01']]
      )
      expect(hosts).to.deep.equal([{ mac, owner: 'gwalice', fresh: true }])
    })

    it('takes the gateway’s port from DECNET_GATEWAY_TAP', async () => {
      const node = block.start_node + 2
      const mac = fakeGateway.decnetMac(`23.${node}`)
      await query('DELETE FROM host WHERE mac_address = $1', [mac])
      process.env.DECNET_GATEWAY_TAP = 'gw1'
      try {
        await bridgeInfo.updateHosts([['gw1', mac]], {})
      } finally {
        delete process.env.DECNET_GATEWAY_TAP
      }
      const hosts = await query('SELECT 1 FROM host WHERE mac_address = $1', [
        mac,
      ])
      expect(hosts).to.have.length(1)
    })

    describe('reconciliation', () => {
      it('removes rs: clients without an active record', async () => {
        const stray = {
          key_id: 900,
          name: 'rs:00000000-0000-4000-8000-000000000000 gone/GONE',
          address: '23.1000',
        }
        const manual = { key_id: 901, name: 'lab vax', address: '23.1001' }
        gw.state.clients.set(stray.key_id, stray)
        gw.state.clients.set(manual.key_id, manual)
        const result = await gatewayClients.reconcile()
        expect(result.removed).to.deep.equal([900])
        expect(gw.state.clients.has(900)).to.equal(false)
        expect(gw.state.clients.has(901)).to.equal(true)
        gw.state.clients.delete(901)
      })

      it('marks records the gateway does not know as needing a new key', async () => {
        const [record] = await query(
          `SELECT c.id, c.key_id FROM decnet_gateway_client c
           WHERE c.name = 'BOBBY' AND c.revoked_at IS NULL`
        )
        gw.state.clients.delete(record.key_id)
        const result = await gatewayClients.reconcile()
        expect(result.needsRekey).to.deep.equal([record.id])
        const [row] = await query(
          'SELECT key_id, needs_rekey FROM decnet_gateway_client WHERE id = $1',
          [record.id]
        )
        expect(row).to.deep.equal({ key_id: null, needs_rekey: true })

        const rekeyed = await bob.post(
          `/api/decnet/gateway-clients/${record.id}/rekey`
        )
        expect(rekeyed.status).to.equal(200)
        expect(rekeyed.body.client.needs_rekey).to.equal(false)
        expect(gw.state.clients.get(rekeyed.body.client.key_id).name).to.equal(
          `rs:${record.id} gwbob/BOBBY`
        )
      })
    })

    describe('block changes', () => {
      it('revokes the block’s clients when an admin reassigns it', async () => {
        const [record] = await query(
          `SELECT c.id, c.key_id, c.user_id FROM decnet_gateway_client c
           WHERE c.name = 'BOBBY' AND c.revoked_at IS NULL`
        )
        const [bobBlock] = await query(
          'SELECT id FROM decnet_block WHERE user_id = $1',
          [record.user_id]
        )
        const response = await admin
          .put(`/api/decnet/blocks/${bobBlock.id}`)
          .send({ username: 'gwalice' })
        expect(response.status).to.equal(200)
        expect(gw.state.clients.has(record.key_id)).to.equal(false)
        const [row] = await query(
          'SELECT revoke_reason FROM decnet_gateway_client WHERE id = $1',
          [record.id]
        )
        expect(row.revoke_reason).to.equal('Block neu zugewiesen')
      })

      it('revokes the block’s clients when an admin releases it', async () => {
        const active = await query(
          `SELECT key_id FROM decnet_gateway_client
           WHERE revoked_at IS NULL AND node_number BETWEEN $1 AND $2`,
          [block.start_node, block.end_node]
        )
        expect(active.length).to.be.greaterThan(0)
        const response = await admin.delete(`/api/decnet/blocks/${block.id}`)
        expect(response.status).to.equal(204)
        for (const { key_id } of active) {
          expect(gw.state.clients.has(key_id)).to.equal(false)
        }
        expect(
          await query(
            `SELECT 1 FROM decnet_gateway_client
             WHERE revoked_at IS NULL AND address LIKE '23.%'
               AND split_part(address, '.', 2)::int BETWEEN $1 AND $2`,
            [block.start_node, block.end_node]
          )
        ).to.be.empty
      })

      it('lets an admin allocate the released range again', async () => {
        const response = await admin.post('/api/decnet/blocks').send({
          username: 'gwbob',
          start_node: block.start_node,
          end_node: block.end_node,
        })
        expect(response.status).to.equal(201)
      })
    })

    describe('user deletion', () => {
      it('drops the user’s records, and reconciliation their keys', async () => {
        await createUser('gwcarol')
        const [carol] = await query(
          `SELECT id FROM "user" WHERE name = 'gwcarol'`
        )
        // A client on a node that stays when its user goes: a block of
        // another member's, as after a reassignment.
        const [bobBlock] = await query(
          `SELECT b.id, b.start_node FROM decnet_block b
           JOIN "user" u ON u.id = b.user_id WHERE u.name = 'gwbob'
           ORDER BY b.start_node LIMIT 1`
        )
        await query(
          `INSERT INTO decnet_host (node_number, block_id, name)
           VALUES ($1, $2, 'CAROL')`,
          [bobBlock.start_node + 1, bobBlock.id]
        )
        const [record] = await query(
          `INSERT INTO decnet_gateway_client
             (user_id, node_number, address, name, key_id)
           VALUES ($1, $2, $3, 'CAROL', 950) RETURNING id`,
          [carol.id, bobBlock.start_node + 1, `23.${bobBlock.start_node + 1}`]
        )
        gw.state.clients.set(950, {
          key_id: 950,
          name: `rs:${record.id} gwcarol/CAROL`,
          address: `23.${bobBlock.start_node + 1}`,
        })
        await query(`DELETE FROM "user" WHERE id = $1`, [carol.id])
        await gatewayClients.reconcile()
        expect(gw.state.clients.has(950)).to.equal(false)
      })
    })
  })
})
