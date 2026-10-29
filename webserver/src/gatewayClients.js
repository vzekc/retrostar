// DECnet gateway clients: a member's named DECnet node reaching the RetroStar
// network through the decnet-gateway daemon. The database holds each
// client's record (owner, node, the gateway's key id and the key's
// fingerprint); the gateway holds the key. The connection line that carries
// the key goes to the member once, when the key is issued.

const db = require('./db')
const event = require('./event')
const gateway = require('./decnetGateway')

const HOST_SEEN_DAYS = 30
const REKEYS_PER_DAY = 10
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,5}$/

class HttpError extends Error {
  constructor(status, error, message, details) {
    super(message || error)
    this.status = status
    this.error = error
    this.details = details
  }
}

// Ids of records whose key the gateway is issuing right now, in a
// transaction other connections cannot see yet; reconciliation leaves their
// gateway clients alone.
const pending = new Set()

const clientColumns = `
  c.id, c.user_id, u.name AS owner, c.node_number, c.address, c.name,
  c.key_id, c.key_fingerprint, c.created_at, c.rekeyed_at, c.last_seen,
  c.needs_rekey, c.revoked_at, c.revoke_reason`

const getClient = async (client, id, { forUpdate } = {}) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const result = await client.query(
    `SELECT ${clientColumns}
     FROM decnet_gateway_client c
     JOIN "user" u ON u.id = c.user_id
     WHERE c.id = $1 ${forUpdate ? 'FOR UPDATE OF c' : ''}`,
    [id]
  )
  return result.rows[0]
}

const listClients = async (client, { userId, all }) => {
  const result = await client.query(
    `SELECT ${clientColumns}
     FROM decnet_gateway_client c
     JOIN "user" u ON u.id = c.user_id
     WHERE c.revoked_at IS NULL
       AND ($1::boolean OR c.user_id = $2)
     ORDER BY u.name, c.node_number`,
    [!!all, userId]
  )
  return result.rows
}

// The machine last seen with node's MAC on the bridge within the last 30
// days, or undefined.
const recentHost = async (client, nodeNumber) => {
  const result = await client.query(
    `SELECT h.mac_address, h.last_seen, h.user_id, u.name AS owner
     FROM host h
     JOIN "user" u ON u.id = h.user_id
     WHERE h.mac_address = decnet_mac($1)
       AND h.last_seen > NOW() - make_interval(days => $2)`,
    [nodeNumber, HOST_SEEN_DAYS]
  )
  return result.rows[0]
}

// Every node of the member's blocks, with its name, its active gateway
// client and the machine recently seen with its address.
const listNodes = async (client, userId) => {
  const result = await client.query(
    `SELECT n AS node_number,
            '23.' || n AS address,
            dh.name,
            c.id AS client_id,
            h.last_seen AS host_last_seen,
            hu.name AS host_owner
     FROM decnet_block b
     CROSS JOIN LATERAL generate_series(b.start_node, b.end_node) AS n
     LEFT JOIN decnet_host dh ON dh.node_number = n
     LEFT JOIN decnet_gateway_client c
            ON c.node_number = n AND c.revoked_at IS NULL
     LEFT JOIN host h
            ON h.mac_address = decnet_mac(n)
           AND h.last_seen > NOW() - make_interval(days => $2)
     LEFT JOIN "user" hu ON hu.id = h.user_id
     WHERE b.user_id = $1
     ORDER BY n`,
    [userId, HOST_SEEN_DAYS]
  )
  return result.rows.map((row) => ({
    ...row,
    host_seen: row.host_last_seen
      ? { last_seen: row.host_last_seen, owner: row.host_owner }
      : null,
    host_last_seen: undefined,
    host_owner: undefined,
  }))
}

const gatewayFailure = (e) => {
  if (e instanceof gateway.GatewayUnavailable) {
    return new HttpError(
      503,
      'gateway-unavailable',
      'Das DECnet-Gateway ist nicht erreichbar.'
    )
  }
  if (e.code === 'exists' || e.code === 'address-in-use') {
    return new HttpError(
      409,
      e.code,
      'Das DECnet-Gateway kennt diese Adresse bereits.'
    )
  }
  return e
}

const issued = (record, response) => ({
  client: {
    ...record,
    key_id: response.key_id,
    key_fingerprint: response.fingerprint,
  },
  line: response.line,
  mac: response.mac,
})

// Creates a gateway client for node in the member's block, naming the node.
// The record is inserted and the key issued in one transaction; a key whose
// record does not commit is removed again.
const createClient = async (user, { node_number, name, move }) => {
  const nodeNumber = Number(node_number)
  if (!Number.isInteger(nodeNumber)) {
    throw new HttpError(400, 'bad-request', 'node_number fehlt.')
  }
  let issuedKeyId = null
  let id = null
  try {
    return await db.withClient(async (client) => {
      const block = await client.query(
        `SELECT id FROM decnet_block
         WHERE user_id = $1 AND $2 BETWEEN start_node AND end_node`,
        [user.id, nodeNumber]
      )
      if (block.rows.length === 0) {
        throw new HttpError(
          403,
          'not-owner',
          'Dieser Knoten liegt nicht in Deinem DECnet-Block.'
        )
      }
      const existingName = (
        await client.query(
          `SELECT name FROM decnet_host WHERE node_number = $1`,
          [nodeNumber]
        )
      ).rows[0]?.name
      const nodeName = (name || existingName || '').toUpperCase()
      if (!NAME_PATTERN.test(nodeName)) {
        throw new HttpError(
          400,
          'bad-name',
          'Der Knotenname hat 1 bis 6 Zeichen, Buchstaben und Ziffern, und beginnt mit einem Buchstaben.'
        )
      }
      const active = await client.query(
        `SELECT 1 FROM decnet_gateway_client
         WHERE node_number = $1 AND revoked_at IS NULL`,
        [nodeNumber]
      )
      if (active.rows.length > 0) {
        throw new HttpError(
          409,
          'node-in-use',
          'Dieser Knoten hat bereits einen Gateway-Zugang.'
        )
      }
      const host = await recentHost(client, nodeNumber)
      if (host && host.user_id !== user.id) {
        throw new HttpError(
          409,
          'host-of-other-member',
          `Unter dieser Adresse war in den letzten ${HOST_SEEN_DAYS} Tagen eine Maschine von ${host.owner} im Netz.`,
          { host_seen: { last_seen: host.last_seen, owner: host.owner } }
        )
      }
      if (host && !move) {
        throw new HttpError(
          409,
          'host-seen',
          `Unter dieser Adresse war in den letzten ${HOST_SEEN_DAYS} Tagen eine Maschine im Netz. Bestätige, dass Du sie hinter das Gateway verlegst.`,
          { host_seen: { last_seen: host.last_seen, owner: host.owner } }
        )
      }
      await client.query('SAVEPOINT name_node')
      try {
        await db.setDecnetHostName(client, user.id, nodeNumber, nodeName)
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT name_node')
        if (e.code === '23505') {
          throw new HttpError(
            409,
            'name-taken',
            `Der Name ${nodeName} ist bereits vergeben.`
          )
        }
        throw e
      }
      const inserted = await client.query(
        `INSERT INTO decnet_gateway_client
           (user_id, node_number, address, name)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [user.id, nodeNumber, `23.${nodeNumber}`, nodeName]
      )
      id = inserted.rows[0].id
      pending.add(id)
      let response
      try {
        response = await gateway.add(
          gateway.clientName(id, user.username, nodeName),
          nodeNumber
        )
      } catch (e) {
        throw gatewayFailure(e)
      }
      issuedKeyId = response.key_id
      await client.query(
        `UPDATE decnet_gateway_client
         SET key_id = $2, key_fingerprint = $3
         WHERE id = $1`,
        [id, response.key_id, response.fingerprint]
      )
      return issued(await getClient(client, id), response)
    })
  } catch (e) {
    if (issuedKeyId !== null) {
      await gateway
        .removeIfPresent(issuedKeyId)
        .catch((e) => console.log('decnet-gateway: remove failed:', e.message))
    }
    throw e
  } finally {
    pending.delete(id)
  }
}

const mayManage = (user, record) =>
  record && (record.user_id === user.id || user.is_admin)

const getManagedClient = async (client, user, id, options) => {
  const record = await getClient(client, id, options)
  if (!record || record.revoked_at || !mayManage(user, record)) {
    throw new HttpError(404, 'not-found', 'Gateway-Zugang nicht gefunden.')
  }
  return record
}

// Issues a new key for a client, at most ten times a day. A client the
// gateway no longer knows gets a key of a new id.
const rekeyClient = async (user, id) => {
  let issuedKeyId = null
  try {
    return await db.withClient(async (client) => {
      const record = await getManagedClient(client, user, id, {
        forUpdate: true,
      })
      const count = await client.query(
        `SELECT CASE WHEN rekey_day = CURRENT_DATE THEN rekey_count ELSE 0 END
                  AS count
         FROM decnet_gateway_client WHERE id = $1`,
        [id]
      )
      if (count.rows[0].count >= REKEYS_PER_DAY) {
        throw new HttpError(
          429,
          'rekey-limit',
          `Höchstens ${REKEYS_PER_DAY} neue Schlüssel pro Tag.`
        )
      }
      pending.add(id)
      let response
      try {
        if (record.key_id !== null && !record.needs_rekey) {
          try {
            response = await gateway.rekey(record.key_id)
          } catch (e) {
            if (e.code !== 'not-found') throw e
          }
        }
        if (!response) {
          response = await gateway.add(
            gateway.clientName(id, record.owner, record.name),
            record.node_number
          )
          issuedKeyId = response.key_id
        }
      } catch (e) {
        throw gatewayFailure(e)
      }
      await client.query(
        `UPDATE decnet_gateway_client
         SET key_id = $2,
             key_fingerprint = $3,
             rekeyed_at = NOW(),
             needs_rekey = FALSE,
             rekey_count = CASE WHEN rekey_day = CURRENT_DATE
                                THEN rekey_count + 1 ELSE 1 END,
             rekey_day = CURRENT_DATE
         WHERE id = $1`,
        [id, response.key_id, response.fingerprint]
      )
      return issued(await getClient(client, id), response)
    })
  } catch (e) {
    if (issuedKeyId !== null) {
      await gateway
        .removeIfPresent(issuedKeyId)
        .catch((e) => console.log('decnet-gateway: remove failed:', e.message))
    }
    throw e
  } finally {
    pending.delete(id)
  }
}

// Removes the record's key at the gateway and marks it revoked. With the
// gateway unreachable, the record is revoked all the same and the next
// reconciliation removes the key.
const revokeRecord = async (client, record, revokedBy, reason) => {
  if (record.key_id !== null) {
    try {
      await gateway.removeIfPresent(record.key_id)
    } catch (e) {
      if (!(e instanceof gateway.GatewayUnavailable)) throw e
      console.log('decnet-gateway: revoking while unreachable:', e.message)
    }
  }
  await client.query(
    `UPDATE decnet_gateway_client
     SET revoked_at = NOW(), revoked_by = $2, revoke_reason = $3
     WHERE id = $1`,
    [record.id, revokedBy, reason || null]
  )
}

const revokeClient = async (client, user, id, reason) => {
  const record = await getManagedClient(client, user, id, { forUpdate: true })
  await revokeRecord(client, record, user.id, reason)
}

// Revokes the active clients on nodes of a block, as its release or
// reassignment does.
const revokeBlockClients = async (client, blockId, revokedBy, reason) => {
  const result = await client.query(
    `SELECT c.id, c.key_id
     FROM decnet_gateway_client c
     JOIN decnet_block b ON c.node_number BETWEEN b.start_node AND b.end_node
     WHERE b.id = $1 AND c.revoked_at IS NULL
     FOR UPDATE OF c`,
    [blockId]
  )
  for (const record of result.rows) {
    await revokeRecord(client, record, revokedBy, reason)
  }
}

// Revoked records keep their address; their node may go.
const detachRevoked = (client, condition, params) =>
  client.query(
    `UPDATE decnet_gateway_client
     SET node_number = NULL
     WHERE revoked_at IS NOT NULL AND node_number IN (${condition})`,
    params
  )

const detachRevokedFromNode = (client, nodeNumber) =>
  detachRevoked(client, '$1', [nodeNumber])

const detachRevokedFromBlock = (client, blockId) =>
  detachRevoked(
    client,
    `SELECT node_number FROM decnet_host WHERE block_id = $1`,
    [blockId]
  )

const nodeHasActiveClient = async (client, nodeNumber) =>
  (
    await client.query(
      `SELECT 1 FROM decnet_gateway_client
       WHERE node_number = $1 AND revoked_at IS NULL`,
      [nodeNumber]
    )
  ).rows.length > 0

// Brings the gateway and the database into agreement: a gateway client
// named rs:<id> without an active record of that id and key is removed; an
// active record the gateway does not know is marked as needing a new key.
const reconcile = async () => {
  const gatewayClients = await gateway.list()
  return db.withClient(async (client) => {
    const result = await client.query(
      `SELECT id, key_id FROM decnet_gateway_client
       WHERE revoked_at IS NULL`
    )
    const active = new Map(result.rows.map((row) => [row.id, row]))
    const removed = []
    const known = new Set()
    for (const gatewayClient of gatewayClients) {
      const id = gateway.recordId(gatewayClient.name)
      if (!id || pending.has(id)) continue
      const record = active.get(id)
      if (record && record.key_id === gatewayClient.key_id) {
        known.add(id)
      } else {
        await gateway.removeIfPresent(gatewayClient.key_id)
        removed.push(gatewayClient.key_id)
      }
    }
    const unknown = result.rows
      .filter(({ id, key_id }) => key_id !== null && !known.has(id))
      .filter(({ id }) => !pending.has(id))
      .map(({ id }) => id)
    if (unknown.length > 0) {
      await client.query(
        `UPDATE decnet_gateway_client
         SET needs_rekey = TRUE, key_id = NULL
         WHERE id = ANY($1::uuid[])`,
        [unknown]
      )
    }
    return { removed, needsRekey: unknown }
  })
}

// The live state of a client at the gateway, endpoint included. Nothing of
// it is stored.
const clientStatus = async (client, user, id) => {
  const record = await getManagedClient(client, user, id)
  if (record.key_id === null) {
    return { known: false, needs_rekey: record.needs_rekey }
  }
  let stats
  try {
    stats = await gateway.stats(record.key_id)
  } catch (e) {
    if (e.code === 'not-found') {
      return { known: false, needs_rekey: true }
    }
    throw gatewayFailure(e)
  }
  const entry = stats.find(({ key_id }) => key_id === record.key_id)
  return entry ? { known: true, ...entry } : { known: false }
}

const gatewayAvailable = async () => {
  try {
    const response = await gateway.hello()
    return { available: true, version: response.version }
  } catch (e) {
    return { available: false }
  }
}

// Polls the gateway: reconciles, records when clients were last seen and
// publishes their connects and disconnects. Endpoints stay out of the
// database and the event log.
const createPoller = () => {
  let connected = null
  let reachable = null

  const poll = async () => {
    let stats
    try {
      await reconcile()
      stats = await gateway.stats()
    } catch (e) {
      if (reachable !== false) {
        console.log('decnet-gateway: not available:', e.message)
      }
      reachable = false
      return
    }
    if (reachable !== true) console.log('decnet-gateway: available')
    reachable = true

    const now = new Set(
      stats.filter((s) => s.connected).map(({ key_id }) => key_id)
    )
    await db.withClient(async (client) => {
      const result = await client.query(
        `SELECT c.key_id, c.name, c.address, u.name AS owner
         FROM decnet_gateway_client c
         JOIN "user" u ON u.id = c.user_id
         WHERE c.revoked_at IS NULL AND c.key_id IS NOT NULL`
      )
      const records = new Map(result.rows.map((row) => [row.key_id, row]))
      if (now.size > 0) {
        await client.query(
          `UPDATE decnet_gateway_client SET last_seen = NOW()
           WHERE revoked_at IS NULL AND key_id = ANY($1::integer[])`,
          [[...now]]
        )
      }
      if (connected) {
        for (const keyId of now) {
          const record = records.get(keyId)
          if (!connected.has(keyId) && record) {
            await event.publish(
              'decnet-gateway-connect',
              `${record.name} (${record.address}) von ${record.owner} ist über das DECnet-Gateway verbunden`,
              {
                username: record.owner,
                name: record.name,
                address: record.address,
              }
            )
          }
        }
        for (const keyId of connected) {
          const record = records.get(keyId)
          if (!now.has(keyId) && record) {
            await event.publish(
              'decnet-gateway-disconnect',
              `${record.name} (${record.address}) von ${record.owner} hat die Verbindung zum DECnet-Gateway beendet`,
              {
                username: record.owner,
                name: record.name,
                address: record.address,
              }
            )
          }
        }
      }
    })
    connected = now
  }

  return { poll }
}

const startPoller = (intervalMs = 10000) => {
  const poller = createPoller()
  const run = () =>
    poller.poll().catch((e) => console.log('decnet-gateway poll:', e.message))
  run()
  return setInterval(run, intervalMs)
}

module.exports = {
  HttpError,
  HOST_SEEN_DAYS,
  REKEYS_PER_DAY,
  listClients,
  listNodes,
  createClient,
  rekeyClient,
  revokeClient,
  revokeBlockClients,
  detachRevokedFromNode,
  detachRevokedFromBlock,
  nodeHasActiveClient,
  reconcile,
  clientStatus,
  gatewayAvailable,
  createPoller,
  startPoller,
}
