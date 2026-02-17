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

const touchHosts = async (usersAndHosts) =>
  withClient(async (client) =>
    usersAndHosts.forEach(([username, hostname]) =>
      client.query('SELECT update_host($1, $2)', [username, hostname])
    )
  )

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
           h.software,
           h.blacklisted,
           u.name AS owner,
           coalesce(h.description, '') <> '' as has_description,
           ev.vendor
       FROM host h
                JOIN "user" u ON u.id = h.user_id
                LEFT OUTER JOIN ethernet_vendor ev ON (h.mac_address & 'ff:ff:ff:00:00:00'::macaddr) = ev.mac_prefix
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
              h.software,
              h.blacklisted
          FROM
              host h
                  LEFT JOIN protocol p ON p.number = ANY(h.protocols)
                  JOIN "user" u ON u.id = h.user_id
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
              h.software,
              h.blacklisted`,
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
  { name, description, hardware, software, blacklisted }
) =>
  withClient(async (client) => {
    const result = await client.query(
      `UPDATE host
       SET name        = COALESCE($3, name),
           description = COALESCE($4, description),
           hardware    = COALESCE($5, hardware),
           software    = COALESCE($6, software),
           blacklisted = COALESCE($7, blacklisted)
       WHERE mac_address = $1
         AND user_id = (SELECT id
                        FROM "user"
                        WHERE name = $2);`,
      [macAddress, username, name, description, hardware, software, blacklisted]
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

const getDecnetBlocks = async (client) => {
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
           json_build_object('node_number', h.node_number, 'name', h.name)
           ORDER BY h.node_number
         ) FILTER (WHERE h.node_number IS NOT NULL),
         '[]'
       ) AS hosts
     FROM decnet_block b
     JOIN "user" u ON u.id = b.user_id
     LEFT JOIN decnet_host h ON h.block_id = b.id
     GROUP BY b.id, u.name
     ORDER BY b.start_node`
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

const setUserAdmin = async (userId, isAdmin) =>
  withClient(async (client) => {
    await client.query(`UPDATE "user" SET is_admin = $1 WHERE id = $2`, [
      isAdmin,
      userId,
    ])
  })

const getUserAdmin = async (userId) =>
  withClient(async (client) => {
    const result = await client.query(
      `SELECT is_admin FROM "user" WHERE id = $1`,
      [userId]
    )
    return result.rows[0]?.is_admin || false
  })

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
  getHost,
  getAllHosts,
  getActiveHosts,
  updateHost,
  updateHostProtocols,
  getProtocols,
  getUserId,
  getDecnetBlocks,
  allocateDecnetBlock,
  adminAllocateDecnetBlock,
  releaseDecnetBlock,
  reassignDecnetBlock,
  setDecnetHostName,
  removeDecnetHostName,
  getUserBlockCount,
  setUserAdmin,
  getUserAdmin,
}
