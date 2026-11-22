const { Pool } = require('pg')

const pool = new Pool({
  connectionTimeoutMillis: 5000,
  max: 100,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE || 'retrostar',
  port: process.env.PGPORT,
})

const connect = async () => pool.connect()

const closePool = async () => pool.end()

// Middleware function to allocate PostgreSQL database connection and manage transactions
const withClient = async (handler) => {
  const client = await connect()
  let result = null
  try {
    await client.query('BEGIN')
    result = await handler(client)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    await client.release()
  }
  return result
}

const middleware = async (ctx, next) =>
  withClient(async (client) => {
    ctx.state.db = client
    await next()
  })

const getConfigurationByInstallKey = async (client, installKey) => {
  const result = await client.query(
    'SELECT u.name, oc.port_number, oc.certificate, oc.private_key FROM openvpn_configuration oc JOIN "user" u ON u.id = oc.user_id WHERE install_key = $1',
    [installKey]
  )

  return result.rows[0]
}

const getInstallKeysByUser = async (client, username) => {
  const result = await client.query(
    'SELECT oc.install_key, oc.config_name FROM "user" u JOIN openvpn_configuration oc ON oc.user_id = u.id WHERE u.name = $1',
    [username]
  )

  return result.rows
}

const checkPassword = async (username, password) =>
  withClient(async (client) => {
    const result = await client.query('SELECT check_password($1, $2)', [
      username,
      password,
    ])
    if (!result.rows[0].check_password) {
      return null
    }
    const user = await client.query(
      'SELECT id, name AS username, is_admin FROM "user" WHERE name = $1',
      [username]
    )
    return user.rows[0]
  })

const checkPasswordResetKey = async (key) =>
  withClient(async (client) => {
    const result = await client.query(
      `SELECT password_reset_key_expires_at < NOW() AS expired, NOW(), password_reset_key_expires_at
       FROM "user"
       WHERE password_reset_key = $1`,
      [key]
    )
    if (result.rows.length === 0) {
      console.log('invalid password reset key:', key)
      return false
    } else if (result.rows[0].expired) {
      console.log('expired password reset key:', result.rows[0])
      return false
    } else {
      return true
    }
  })

const resetPassword = async (key, password) =>
  withClient(async (client) => {
    const result = await client.query(
      `SELECT reset_password_with_key($1, $2)`,
      [key, password]
    )
    return result.rows.length > 0
  })

const setPassword = async (username, password) =>
  withClient(async (client) => {
    const result = await client.query(`SELECT set_password($1, $2)`, [
      username,
      password,
    ])
    return result.rows.length > 0
  })

// Each host is recorded on its own, so that one the database refuses leaves
// the others' records intact.
const touchHosts = async (usersAndHosts) =>
  withClient(async (client) => {
    for (const [username, mac] of usersAndHosts) {
      await client.query('SAVEPOINT touch_host')
      try {
        await client.query('SELECT update_host($1, $2)', [username, mac])
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT touch_host')
        console.log('cannot record host', mac, 'of', username, ':', e.message)
      }
    }
  })

const touchGatewayHosts = async (macs) =>
  withClient(async (client) => {
    for (const mac of macs) {
      await client.query('SELECT update_gateway_host($1)', [mac])
    }
  })

const getActiveHosts = async () =>
  withClient(async (client) => {
    const result = await client.query(
      `SELECT
           h.mac_address,
           h.created,
           h.last_seen,
           h.user_id,
           h.name,
           h.protocols,
           h.hardware,
           h.emulated_hardware,
           h.software,
           h.blacklisted,
           u.name AS owner,
           coalesce(h.description, '') <> '' as has_description,
           ev.vendor,
           dh.name AS decnet_name
       FROM host h
                JOIN "user" u ON u.id = h.user_id
                LEFT OUTER JOIN ethernet_vendor ev ON (h.mac_address & 'ff:ff:ff:00:00:00'::macaddr) = ev.mac_prefix
                LEFT OUTER JOIN decnet_host dh ON decnet_mac(dh.node_number) = h.mac_address
       WHERE h.last_seen > NOW() - INTERVAL \'5 minutes\'
         AND h.protocols IS NOT NULL
       ORDER BY u.name, h.mac_address::VARCHAR`
    )
    return result.rows
  })

const getAllHosts = async () =>
  withClient(async (client) => {
    const result = await client.query(
      `SELECT 
           h.mac_address,
           h.created,
           h.last_seen,
           h.user_id,
           h.name,
           h.protocols,
           h.hardware,
           h.emulated_hardware,
           h.software,
           h.blacklisted,
           u.name AS owner,
           coalesce(h.description, '') <> '' as has_description
       FROM host h
                JOIN "user" u ON u.id = h.user_id
       ORDER BY u.name, h.mac_address::VARCHAR`
    )
    return result.rows
  })

const getHost = async (macAddress) =>
  withClient(async (client) => {
    const result = await client.query(
      `
          SELECT
              h.mac_address,
              h.created,
              h.last_seen,
              h.user_id,
              u.name as owner,
              h.name,
              h.description,
              ARRAY_AGG(
                      p.number || ',' || p.name || ',' || p.description
                      ORDER BY p.number
              ) AS protocols,
              h.hardware,
              h.emulated_hardware,
              h.software,
              h.blacklisted,
              dh.name AS decnet_name
          FROM
              host h
                  LEFT JOIN protocol p ON p.number = ANY(h.protocols)
                  JOIN "user" u ON u.id = h.user_id
                  LEFT JOIN decnet_host dh ON decnet_mac(dh.node_number) = h.mac_address
          WHERE
              mac_address = $1
          GROUP BY
              h.mac_address,
              h.created,
              h.last_seen,
              h.user_id,
              u.name,
              h.name,
              h.description,
              h.hardware,
              h.emulated_hardware,
              h.software,
              h.blacklisted,
              dh.name`,
      [macAddress]
    )
    const rows = result.rows.map((row) => {
      return {
        ...row,
        protocols: row.protocols
          .filter((proto) => proto)
          .map((proto) => {
            const fields = proto.split(',', 3)
            return {
              number: parseInt(fields[0]),
              name: fields[1],
              description: fields[2],
            }
          }),
      }
    })
    return rows[0]
  })

const updateHost = async (
  username,
  macAddress,
  { name, description, hardware, emulatedHardware, software, blacklisted }
) =>
  withClient(async (client) => {
    const result = await client.query(
      `UPDATE host
       SET name        = COALESCE($3, name),
           description = COALESCE($4, description),
           hardware    = COALESCE($5, hardware),
           software    = COALESCE($6, software),
           blacklisted = COALESCE($7, blacklisted),
           emulated_hardware = COALESCE($8, emulated_hardware)
       WHERE mac_address = $1
         AND user_id = (SELECT id
                        FROM "user"
                        WHERE name = $2);`,
      [
        macAddress,
        username,
        name,
        description,
        hardware,
        software,
        blacklisted,
        emulatedHardware,
      ]
    )
    return result.rows
  })

const updateHostProtocols = async (macAddress, protocols) =>
  withClient(async (client) => {
    const result = await client.query(
      `UPDATE host
       SET protocols = $2
       WHERE mac_address = $1`,
      [macAddress, protocols]
    )
    return result.rows
  })

const getProtocols = async () =>
  withClient(async function (client) {
    const result = await client.query(
      `SELECT *
       FROM protocol`
    )
    return result.rows.reduce((protocols, { number, name, description }) => {
      protocols[number] = {
        name: name || number.toString(16).toUpperCase(),
        description,
      }
      return protocols
    }, {})
  })

const getUserId = async (username) =>
  withClient(async (client) => {
    const result = await client.query(
      `SELECT id
       FROM "user"
       WHERE name = $1`,
      [username]
    )
    return result.rows[0]?.id
  })

// The id of the user named username, creating the user when there is none.
const ensureUserId = async (username) =>
  withClient(async (client) => {
    const result = await client.query(
      `INSERT INTO "user" (name)
       VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [username]
    )
    return result.rows[0].id
  })

// The blocks with their named hosts. Each host says whether a gateway client
// uses it; with withActivity, also when its machine was last seen on the
// bridge.
const getDecnetBlocks = async (client, { withActivity } = {}) => {
  const result = await client.query(
    `SELECT
       b.id,
       b.start_node,
       b.end_node,
       b.user_id,
       u.name AS owner,
       b.created_at,
       COALESCE(
         json_agg(
           json_build_object(
             'node_number', h.node_number,
             'name', h.name,
             'gateway', c.id IS NOT NULL,
             'last_seen', CASE WHEN $1 THEN m.last_seen END
           )
           ORDER BY h.node_number
         ) FILTER (WHERE h.node_number IS NOT NULL),
         '[]'
       ) AS hosts
     FROM decnet_block b
     JOIN "user" u ON u.id = b.user_id
     LEFT JOIN decnet_host h ON h.block_id = b.id
     LEFT JOIN decnet_gateway_client c
            ON c.node_number = h.node_number AND c.revoked_at IS NULL
     LEFT JOIN host m ON m.mac_address = decnet_mac(h.node_number)
     GROUP BY b.id, u.name
     ORDER BY b.start_node`,
    [!!withActivity]
  )
  return result.rows
}

// The named nodes of the allocation plan, as decnet-nmld reads them.
const getDecnetNodes = async (client) => {
  const result = await client.query(
    `SELECT '23.' || node_number AS address, name
     FROM decnet_host
     ORDER BY node_number`
  )
  return result.rows
}

const allocateDecnetBlock = async (client, userId) => {
  // Find next available contiguous range of 10 addresses starting from 20
  const result = await client.query(
    `SELECT start_node, end_node FROM decnet_block ORDER BY start_node`
  )
  const blocks = result.rows

  let candidate = 20
  for (const block of blocks) {
    if (candidate + 9 < block.start_node) {
      break
    }
    candidate = Math.max(candidate, block.end_node + 1)
  }

  if (candidate + 9 > 1023) {
    return null
  }

  const insert = await client.query(
    `INSERT INTO decnet_block (user_id, start_node, end_node)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, candidate, candidate + 9]
  )
  return insert.rows[0]
}

const adminAllocateDecnetBlock = async (
  client,
  username,
  startNode,
  endNode
) => {
  // Ensure user exists
  let userResult = await client.query(`SELECT id FROM "user" WHERE name = $1`, [
    username,
  ])
  if (userResult.rows.length === 0) {
    return null
  }
  const userId = userResult.rows[0].id

  const insert = await client.query(
    `INSERT INTO decnet_block (user_id, start_node, end_node)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, startNode, endNode]
  )
  return insert.rows[0]
}

const releaseDecnetBlock = async (client, blockId) => {
  const result = await client.query(
    `DELETE FROM decnet_block WHERE id = $1 RETURNING *`,
    [blockId]
  )
  return result.rows[0]
}

const reassignDecnetBlock = async (client, blockId, username) => {
  const userResult = await client.query(
    `SELECT id FROM "user" WHERE name = $1`,
    [username]
  )
  if (userResult.rows.length === 0) {
    return null
  }
  const result = await client.query(
    `UPDATE decnet_block SET user_id = $1 WHERE id = $2 RETURNING *`,
    [userResult.rows[0].id, blockId]
  )
  return result.rows[0]
}

const setDecnetHostName = async (client, userId, nodeNumber, name) => {
  // Verify user owns the block containing this node
  const blockResult = await client.query(
    `SELECT b.id FROM decnet_block b
     WHERE b.user_id = $1
       AND $2 BETWEEN b.start_node AND b.end_node`,
    [userId, nodeNumber]
  )
  if (blockResult.rows.length === 0) {
    return null
  }

  const result = await client.query(
    `INSERT INTO decnet_host (node_number, block_id, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (node_number) DO UPDATE SET name = $3
     RETURNING *`,
    [nodeNumber, blockResult.rows[0].id, name]
  )
  return result.rows[0]
}

const removeDecnetHostName = async (client, nodeNumber) => {
  const result = await client.query(
    `DELETE FROM decnet_host WHERE node_number = $1 RETURNING *`,
    [nodeNumber]
  )
  return result.rows[0]
}

const getUserBlockCount = async (client, userId) => {
  const result = await client.query(
    `SELECT COUNT(*) AS count FROM decnet_block WHERE user_id = $1`,
    [userId]
  )
  return parseInt(result.rows[0].count)
}

// The user of a forum account: the one with its nickname, or else the one
// named after it that has no forum nickname. Answers { id, name } or
// undefined; conflict is true when a user named after the nickname belongs to
// another forum account.
const findForumUser = async (nickname) =>
  withClient(async (client) => {
    const result = await client.query(
      `SELECT id, name, forum_nickname
       FROM "user"
       WHERE LOWER(forum_nickname) = LOWER($1) OR name = LOWER($1)
       ORDER BY (LOWER(forum_nickname) = LOWER($1)) IS TRUE DESC`,
      [nickname]
    )
    const [user] = result.rows
    if (!user) return undefined
    if (
      user.forum_nickname &&
      user.forum_nickname.toLowerCase() !== nickname.toLowerCase()
    ) {
      return { conflict: true }
    }
    return { id: user.id, name: user.name }
  })

// Records what a forum login says about the user: whether they are an
// administrator, their forum nickname and email address.
const setForumUser = async (userId, { isAdmin, nickname, email }) =>
  withClient(async (client) => {
    await client.query(
      `UPDATE "user"
       SET is_admin = $2,
           forum_nickname = COALESCE($3, forum_nickname),
           email = COALESCE($4, email)
       WHERE id = $1`,
      [userId, isAdmin, nickname || null, email || null]
    )
  })

const getUserAdmin = async (userId) =>
  withClient(async (client) => {
    const result = await client.query(
      `SELECT is_admin FROM "user" WHERE id = $1`,
      [userId]
    )
    return result.rows[0]?.is_admin || false
  })

// The users for the administrators' user list: whether they have set a
// password, their pending password reset key and their OpenVPN
// configurations.
const getUsers = async (client, { name } = {}) => {
  const result = await client.query(
    `SELECT u.name,
            u.forum_nickname,
            u.email,
            u.is_admin,
            u.password_hash IS NOT NULL AS has_password,
            CASE WHEN u.password_reset_key_expires_at > NOW()
                 THEN u.password_reset_key END AS password_reset_key,
            CASE WHEN u.password_reset_key_expires_at > NOW()
                 THEN u.password_reset_key_expires_at END
              AS password_reset_key_expires_at,
            COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT(
                  'name', COALESCE(oc.config_name, u.name),
                  'config_name', oc.config_name,
                  'port_number', oc.port_number,
                  'install_key', oc.install_key
                ) ORDER BY oc.port_number
              ) FILTER (WHERE oc.user_id IS NOT NULL),
              '[]'
            ) AS configurations
     FROM "user" u
     LEFT JOIN openvpn_configuration oc ON oc.user_id = u.id
     WHERE $1::varchar IS NULL OR u.name = $1
     GROUP BY u.id
     ORDER BY u.name`,
    [name || null]
  )
  return result.rows
}

// A new password reset key of the user named username, valid for validFor
// (a PostgreSQL interval).
const requestPasswordReset = async (client, username, validFor) => {
  const result = await client.query(
    'SELECT request_password_reset($1, $2::interval) AS key',
    [username, validFor]
  )
  return result.rows[0].key
}

module.exports = {
  connect,
  closePool,
  withClient,
  middleware,
  getConfigurationByInstallKey,
  getInstallKeysByUser,
  checkPassword,
  checkPasswordResetKey,
  resetPassword,
  setPassword,
  touchHosts,
  touchGatewayHosts,
  getHost,
  getAllHosts,
  getActiveHosts,
  updateHost,
  updateHostProtocols,
  getProtocols,
  getUserId,
  getDecnetBlocks,
  getDecnetNodes,
  allocateDecnetBlock,
  adminAllocateDecnetBlock,
  releaseDecnetBlock,
  reassignDecnetBlock,
  setDecnetHostName,
  removeDecnetHostName,
  getUserBlockCount,
  ensureUserId,
  setForumUser,
  findForumUser,
  getUserAdmin,
  getUsers,
  requestPasswordReset,
}
