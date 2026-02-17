const db = require('./db')

const publish = async (type, message, data) =>
  db.withClient(async (client) => {
    await client.query(
      'INSERT INTO event (type, message, data) VALUES ($1, $2, $3)',
      [type, message, data]
    )
  })

module.exports = { publish }
