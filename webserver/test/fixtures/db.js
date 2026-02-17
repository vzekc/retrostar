const util = require('node:util')
const exec = util.promisify(require('node:child_process').exec)
const path = require('path')

process.env.PGDATABASE = `retrostar-test-${process.pid}`

const db = require('../../src/db')

const migrateScript = path.join(__dirname, '../../../db/migrate.sh')

const up = async () => {
  await exec(`createdb ${process.env.PGDATABASE}`)
  await exec(`${migrateScript} danger:reset`)
  await exec(`${migrateScript} up`)
}

const down = async () => {
  await db.closePool()
  await exec(`dropdb ${process.env.PGDATABASE}`)
}

module.exports = { up, down }
