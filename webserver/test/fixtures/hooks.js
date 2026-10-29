// Root hooks: one isolated database for the whole test run.
const dbFixture = require('./db')

exports.mochaHooks = {
  beforeAll: dbFixture.up,
  afterAll: dbFixture.down,
}
