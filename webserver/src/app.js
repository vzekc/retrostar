require('dotenv').config() // Load environment variables from .env file

const fs = require('fs')
const crypto = require('crypto')
const marked = require('marked')
const ejs = require('ejs')
const Koa = require('koa')
const Router = require('koa-router')
const route = require('koa-route')
const { koaBody } = require('koa-body')
const koaStatic = require('koa-static')
const { createSession: session } = require('koa-session')
const websockify = require('koa-websocket')
const passport = require('koa-passport')
const OIDCStrategy = require('passport-openidconnect').Strategy
const sanitizeHtml = require('sanitize-html')
const path = require('path')
const Ajv = require('ajv')

const db = require('./db')
const event = require('./event')
const lattice = require('./lattice')

const app = websockify(new Koa())
const router = new Router()
const ethernetToDecnet = require('./ethernetToDecnet')

const resolvePath = (...components) => path.join(__dirname, '..', ...components)

const readFileSync = (...components) =>
  fs.readFileSync(resolvePath(...components), { encoding: 'utf8' })

app.use(
  koaBody({
    multipart: true,
    jsonLimit: '20mb',
    textLimit: '20mb',
    formLimit: '20mb',
  })
)
app.use(koaStatic(resolvePath('public')))

// Session middleware
app.keys = [process.env.SESSION_SECRET]
app.use(session({}, app))
app.ws.use(session({}, app))

// Initialize passport middleware
const passportMiddleware = passport.initialize()
app.use(passportMiddleware)
app.ws.use(passportMiddleware)
const passportSession = passport.session()
app.use(passportSession)
app.ws.use(passportSession)

const verifyForumLogin = async (
  issuer,
  uiProfile,
  idProfile,
  context,
  idToken,
  accessToken,
  refreshToken,
  params,
  verified
) => {
  // The verify strategy callback must have this signature so that the raw
  // profile information is available in the `idProfile` parameter.

  const claims = uiProfile._json
  const username = claims.nickname.toLowerCase()
  const userId = await db.getUserId(username)
  if (
    !userId &&
    !claims.rank?.match(
      /^(Fördermitglied|Schiedsrichter|Vereinsmitglied|Vorstand|Moderator|Administrator)$/
    )
  ) {
    console.log('unauthorized forum user', username, claims.rank)
    return verified(null, false, {
      message:
        'Dieses System ist nur für Mitglieder des VzEkC e.V. zugänglich.',
    })
  }
  const isAdmin = /^(Vorstand|Administrator)$/.test(claims.rank)
  if (userId) {
    await db.setUserAdmin(userId, isAdmin)
  }
  await event.publish(
    'web-login',
    `${username} hat sich über das Forum auf dem Webserver angemeldet.`,
    { username }
  )
  return verified(null, {
    username: username,
    id: userId,
    is_admin: isAdmin,
  })
}

// GitHub OAuth2 configuration
passport.use(
  'oidc',
  new OIDCStrategy(
    {
      issuer: process.env.OIDC_ISSUER,
      clientID: process.env.OIDC_CLIENT_ID,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
      callbackURL: process.env.OIDC_CALLBACK_URL,
      authorizationURL: process.env.OIDC_AUTHORIZATION_URL,
      tokenURL: process.env.OIDC_TOKEN_URL,
      userInfoURL: process.env.OIDC_USERINFO_URL,
      scope: ['openid', 'nickname', 'email', 'rank', 'profile'],
    },
    verifyForumLogin
  )
)

const LocalStrategy = require('passport-local').Strategy

// Define the Local strategy for username/password authentication
passport.use(
  new LocalStrategy(async (username, password, done) => {
    try {
      // Call the checkUser function to verify the username/password
      const user = await db.checkPassword(username, password)

      if (user) {
        // If the user is found and the password is correct, return the user
        done(null, user)
      } else {
        // If the user is not found or the password is incorrect, return false
        done(null, false)
      }
    } catch (error) {
      done(error)
    }
  })
)

// Serialize user into session
passport.serializeUser((user, done) => {
  done(null, user)
})

// Deserialize user from session
passport.deserializeUser((user, done) => {
  done(null, user)
})

const isAuthenticated = async (ctx, next) => {
  if (ctx.isAuthenticated()) {
    await next()
  } else {
    if (ctx.accepts('html')) {
      ctx.redirect('/login?path=' + ctx.path)
    } else {
      ctx.status = 403
      ctx.body = 'Forbidden'
    }
  }
}

app.use(db.middleware)

const renderTemplate = (content, state, data) =>
  ejs.render(content, { ...state, ...(data || {}) })
const renderTemplateFile = (filename, state, data) =>
  renderTemplate(readFileSync('templates', filename), state, data)

router.get('/client-config/:installKey', async (ctx) => {
  const installKey = ctx.params.installKey?.toUpperCase()
  const configuration = await db.getConfigurationByInstallKey(
    ctx.state.db,
    installKey
  )

  if (configuration) {
    ctx.type = 'text/plain'
    ctx.body = renderTemplateFile('client-config.ejs', ctx.state, {
      ...configuration,
      ca_certificate: readFileSync('../ca/data', 'ca.crt'),
      ta_key: readFileSync('../ca/data', 'ta.key'),
    })
  } else {
    ctx.status = 404
    ctx.body = 'Configuration not found'
  }
})

const markdownOptions = {
  renderer: new marked.Renderer(),
  gfm: true,
  breaks: false,
}

router.get('/installation', isAuthenticated, async (ctx, next) => {
  const username = ctx.state.user.username

  ctx.state.installKeys = await db.getInstallKeysByUser(ctx.state.db, username)
  if (
    process.env.ENVIRONMENT !== 'production' &&
    ctx.state.installKeys.length === 0
  ) {
    ctx.state.installKeys = ['XXXX-XXXX']
  }
  ctx.state.installKey = ctx.state.installKeys[0]?.install_key

  await next()
})

router.get('/status', async (ctx, next) => {
  const protocols = await db.getProtocols()
  ctx.state.hosts = (await db.getActiveHosts()).map((host) => ({
    ...host,
    editable: ctx.state.user?.id === host.user_id,
    protocols: host.protocols?.sort().map((number) => {
      const protocol = protocols[number]
      return {
        name: protocol?.name || number.toString(16).toUpperCase(),
        description: protocol?.description,
      }
    }),
    decnet: ethernetToDecnet(host.mac_address),
  }))

  await next()
})

const getLatServices = async () => {
  try {
    const services = await lattice.getServices()
    return services.filter(({ available }) => available)
  } catch (e) {
    console.log('cannot list LAT services:', e.message)
    return []
  }
}

router.get('/lat', async (ctx, next) => {
  ctx.state.services = await getLatServices()
  await next()
})

router.get('/set-password', async (ctx, next) => {
  const key = ctx.request.query.key
  if (key) {
    ctx.state.keyValid = await db.checkPasswordResetKey(key)
    ctx.state.key = key
  } else {
    ctx.state.keyValid = false
    ctx.state.key = ''
  }
  next()
})

router.get('/login', (ctx, next) => {
  if (ctx.session.messages) {
    ctx.state.message = ctx.session.messages[0]
    delete ctx.session.messages
  } else {
    ctx.state.message = null
  }
  next()
})

router.get('/hostinfo/:mac_address', async (ctx, next) => {
  ctx.state.host = await db.getHost(ctx.params.mac_address)
  ctx.state.editable = ctx.state.user?.id === ctx.state.host?.user_id
  await next()
})

router.get('/:page/:arg?', (ctx, next) => {
  if (ctx.params.page === 'auth') {
    return next()
  }

  let content = null
  if (fs.existsSync(resolvePath('templates', `${ctx.params.page}.md`))) {
    content = marked.parse(
      renderTemplateFile(`${ctx.params.page}.md`, ctx.state),
      markdownOptions
    )
  } else if (
    fs.existsSync(resolvePath('templates', `${ctx.params.page}.html`))
  ) {
    content = renderTemplate(
      readFileSync('templates', `${ctx.params.page}.html`),
      ctx.state
    )
  }

  if (content) {
    // Send the HTML response
    ctx.type = 'text/html'
    ctx.body = renderTemplateFile('layout.ejs', ctx.state, {
      content,
      page_name: ctx.params.page,
    })
  } else {
    next()
  }
})

router.redirect('/', '/status')
router.redirect('/news', '/status')

router.get('/install.sh', (ctx) => {
  ctx.type = 'text/plain'
  ctx.body = renderTemplateFile('install.sh.ejs', ctx.state)
})

// host maintenance

router.get('/api/hosts', async (ctx) => {
  ctx.body = await db.getActiveHosts()
})

const validateHostUpdateSchema = new Ajv().compile({
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    hardware: { type: 'string' },
    software: { type: 'string' },
    blacklisted: { type: 'boolean' },
  },
  additionalProperties: false,
})

const sanitzeHtmlOptions = {
  allowedTags: ['h1', 'h2', 'h3', 'h4', 'p', 'strong', 'em', 'pre', 'img', 'a'],
  allowedSchemes: ['http', 'https', 'data'],
}

router.put('/api/host/:mac_address', isAuthenticated, async (ctx) => {
  const valid = validateHostUpdateSchema(ctx.request.body)

  if (!valid) {
    ctx.status = 400
    ctx.body = {
      message: 'schema validation errors',
      errors: validateHostUpdateSchema.errors,
    }
    return
  }

  // Validate the description field
  const { description } = ctx.request.body
  if (description) {
    ctx.request.body.description = sanitizeHtml(description, sanitzeHtmlOptions)
  }

  await db.updateHost(
    ctx.state.user.username,
    ctx.params.mac_address,
    ctx.request.body
  )

  ctx.status = 204
})

router.get('/auth', passport.authenticate('oidc'))

router.get(
  '/auth/callback',
  passport.authenticate('oidc', {
    successRedirect: '/',
    failureRedirect: '/login',
    failureMessage: true,
  })
)

router.post('/auth/login', async (ctx, next) => {
  // Check if the request body contains username and password
  const { username, password } = ctx.request.body

  if (username && password) {
    // Attempt Local authentication
    await passport.authenticate('local', async (err, user) => {
      if (err) {
        ctx.status = 500
        ctx.body = 'Internal Server Error'
      } else if (!user) {
        if (ctx.accepts('html')) {
          ctx.redirect('/login?error=1&path=' + (ctx.request.query.path || '/'))
        } else {
          ctx.status = 403
        }
      } else {
        // If Local authentication succeeds, log in the user
        await ctx.login(user)
        ctx.redirect(ctx.request.query.path || '/')
        await event.publish(
          'web-login',
          `${username} hat sich auf dem Webserver angemeldet.`,
          { username }
        )
      }
    })(ctx, next)
  } else {
    // If username or password is missing, attempt OIDC authentication
    await passport.authenticate('oidc')(ctx, next)
  }
})

router.post('/auth/set-password', async (ctx) => {
  if (ctx.request.body.key) {
    await db.resetPassword(ctx.request.body.key, ctx.request.body.password)
  } else if (ctx.state.user) {
    await db.setPassword(ctx.state.user.username, ctx.request.body.password)
  } else {
    ctx.status = 400
    return
  }
  ctx.redirect('/login?reset-success=1')
})

// Logout route
router.post('/logout', (ctx) => {
  if (ctx.state?.user?.username) {
    event.publish(
      'web-logout',
      `${ctx.state.user.username} hat sich vom Webserver abgemeldet`
    )
  }
  ctx.logout(() => ctx.redirect('/'))
})

// Admin middleware
const isAdmin = async (ctx, next) => {
  if (ctx.isAuthenticated() && ctx.state.user?.is_admin) {
    await next()
  } else {
    ctx.status = 403
    ctx.body = 'Forbidden'
  }
}

// DECnet address management

router.get('/decnet', isAuthenticated, async (ctx, next) => {
  await next()
})

router.get('/api/decnet/blocks', async (ctx) => {
  const blocks = await db.getDecnetBlocks(ctx.state.db)
  ctx.body = blocks
})

router.post('/api/decnet/blocks', isAuthenticated, async (ctx) => {
  const client = ctx.state.db
  const user = ctx.state.user

  if (user.is_admin && ctx.request.body.username) {
    const { username, start_node, end_node } = ctx.request.body
    if (!username || !start_node || !end_node) {
      ctx.status = 400
      ctx.body = { error: 'username, start_node, and end_node are required' }
      return
    }
    const block = await db.adminAllocateDecnetBlock(
      client,
      username,
      start_node,
      end_node
    )
    if (!block) {
      ctx.status = 404
      ctx.body = { error: 'User not found' }
      return
    }
    ctx.status = 201
    ctx.body = block
  } else {
    const count = await db.getUserBlockCount(client, user.id)
    if (count >= 1) {
      ctx.status = 409
      ctx.body = { error: 'You already have an allocated block' }
      return
    }
    const block = await db.allocateDecnetBlock(client, user.id)
    if (!block) {
      ctx.status = 409
      ctx.body = { error: 'No free address range available' }
      return
    }
    ctx.status = 201
    ctx.body = block
  }
})

router.delete('/api/decnet/blocks/:id', isAdmin, async (ctx) => {
  const block = await db.releaseDecnetBlock(ctx.state.db, ctx.params.id)
  if (!block) {
    ctx.status = 404
    ctx.body = { error: 'Block not found' }
    return
  }
  ctx.status = 204
})

router.put('/api/decnet/blocks/:id', isAdmin, async (ctx) => {
  const { username } = ctx.request.body
  if (!username) {
    ctx.status = 400
    ctx.body = { error: 'username is required' }
    return
  }
  const block = await db.reassignDecnetBlock(
    ctx.state.db,
    ctx.params.id,
    username
  )
  if (!block) {
    ctx.status = 404
    ctx.body = { error: 'Block or user not found' }
    return
  }
  ctx.body = block
})

router.put('/api/decnet/hosts/:nodeNumber', isAuthenticated, async (ctx) => {
  const { name } = ctx.request.body
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'name is required' }
    return
  }
  const nodeNumber = parseInt(ctx.params.nodeNumber)
  const host = await db.setDecnetHostName(
    ctx.state.db,
    ctx.state.user.id,
    nodeNumber,
    name
  )
  if (!host) {
    ctx.status = 403
    ctx.body = { error: 'You do not own a block containing this node' }
    return
  }
  ctx.body = host
})

router.delete('/api/decnet/hosts/:nodeNumber', isAuthenticated, async (ctx) => {
  const nodeNumber = parseInt(ctx.params.nodeNumber)
  // Verify ownership
  const blockResult = await ctx.state.db.query(
    `SELECT b.id FROM decnet_block b
     WHERE b.user_id = $1
       AND $2 BETWEEN b.start_node AND b.end_node`,
    [ctx.state.user.id, nodeNumber]
  )
  if (blockResult.rows.length === 0 && !ctx.state.user.is_admin) {
    ctx.status = 403
    ctx.body = { error: 'You do not own a block containing this node' }
    return
  }
  const host = await db.removeDecnetHostName(ctx.state.db, nodeNumber)
  if (!host) {
    ctx.status = 404
    ctx.body = { error: 'Host not found' }
    return
  }
  ctx.status = 204
})

// Article upload/download
router.post('/api/article', isAuthenticated, async (ctx) => {
  const { content } = ctx.request.body
  const client = ctx.state.db

  const result = await client.query(
    `INSERT INTO article (content)
     VALUES ($1)
     RETURNING id`,
    [content]
  )

  ctx.body = { id: result.rows[0].id }
  ctx.status = 201
})

router.get('/api/article/:id', async (ctx) => {
  const { id } = ctx.params
  const client = ctx.state.db

  const result = await client.query(
    `SELECT *
     FROM article
     WHERE id = $1`,
    [id]
  )

  if (result.rows.length > 0) {
    ctx.body = result.rows[0]
  } else {
    ctx.status = 404
    ctx.body = 'Article not found'
  }
})

router.put('/api/article/:id', isAuthenticated, async (ctx) => {
  const { id } = ctx.params
  const { content } = ctx.request.body
  const client = ctx.state.db

  await client.query(
    `UPDATE article
     SET content = $1
     WHERE id = $2`,
    [content, id]
  )

  ctx.status = 204
})

router.delete('/api/article/:id', isAuthenticated, async (ctx) => {
  const { id } = ctx.params
  const client = ctx.state.db

  await client.query(
    `DELETE
     FROM article
     WHERE id = $1`,
    [id]
  )
  ctx.status = 204
})

// WebSocket route
app.ws.use(
  route.all('/ws/lat/:host', async (ctx, host) => {
    const printOnTerminal = (message) =>
      ctx.websocket.send(`\x07\r\r\n\x1b[1m*** ${message} ***\x1b[0m\r\n\n`)

    if (!ctx.state.user) {
      console.log('unauthorized websocket connection')
      await printOnTerminal('Du bist nicht angemeldet.')
      setTimeout(() => ctx.websocket.close(), 5000)
      return
    }

    console.log('new websocket connection to ', host)

    const username = ctx.state.user.username
    await event.publish(
      'lat-connect',
      `${username} hat eine LAT-Verbindung zu ${host} hergestellt`,
      { username, host }
    )

    const session = lattice.login({
      name: `web.${username}`,
      source: ctx.get('x-forwarded-for').split(',')[0].trim() || ctx.ip,
      terminal: 'vt100',
      type: 'ANSI',
      width: 80,
      height: 24,
      connect: host,
    })

    // Text frames are typed input; a binary frame is passed on as it is,
    // such as the BREAK the page sends.
    ctx.websocket.on('message', (data, isBinary) =>
      session.write(isBinary ? data : lattice.escapeInput(data))
    )
    ctx.websocket.on('error', () => session.destroy())
    ctx.websocket.on('close', () => session.destroy())
    session.on('data', (data) => ctx.websocket.send(data))
    session.on('error', (e) => {
      console.log('lattice:', e.message)
      printOnTerminal('Der Terminalserver ist nicht erreichbar')
    })
    session.on('close', async () => {
      printOnTerminal('Verbindung beendet')
      await event.publish(
        'lat-connect',
        `${username} hat die LAT-Verbindung zu ${host} beendet`,
        { username, host }
      )
      setTimeout(() => ctx.websocket.close(), 5000)
    })
  })
)

app.ws.use(
  route.all('/ws/event-log', async (ctx) => {
    if (!ctx.state.user) {
      console.log('unauthorized websocket connection')
      setInterval(() => ctx.websocket.close(), 5000)
      return
    }

    const client = await db.connect()
    await client.query('LISTEN event')
    const sendEvent = async (event) => ctx.websocket.send(JSON.stringify(event))

    const result = await client.query(`SELECT *
                                       FROM event
                                       ORDER BY timestamp DESC
                                       LIMIT 50`)
    result.rows.reverse().forEach(sendEvent)

    client.removeAllListeners('notification')
    client.on('notification', async (msg) => {
      const result = await client.query(
        `SELECT *
         FROM event
         WHERE id = $1::integer`,
        [msg.payload]
      )
      sendEvent(result.rows[0])
    })
    ctx.websocket.on('message', () => undefined)
    ctx.websocket.on('close', () => client.release())
  })
)

app.use(router.routes())
app.use(router.allowedMethods())

module.exports = app
