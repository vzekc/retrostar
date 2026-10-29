const bridgeInfo = require('./bridgeInfo')
const gatewayClients = require('./gatewayClients')
const app = require('./app')
const event = require('./event')

bridgeInfo.startHostUpdater()
gatewayClients.startPoller()

const port = process.env.PORT || 3000

app.listen(port, async () => {
  console.log(`Server running on port ${port}`)
  event.publish('server-start', 'Der Webserver wurde gestartet')
})
