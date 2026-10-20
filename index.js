require('./src/load-env').loadEnv()
const express = require('express')
const session = require('express-session')
const path = require('path')
const PgSession = require('connect-pg-simple')(session)

const { getPool } = require('./src/db/pool')
const { migrate } = require('./src/db/migrate')
const { seed } = require('./src/db/seed')
const archive = require('./src/lib/archive')
const { attachDb, loadUser, flash } = require('./src/middleware/context')
const { IP_MODULES } = require('./src/lib/modules')

const port = process.env.PORT || 5006
const app = express()

app.set('trust proxy', 1)
app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')
app.disable('x-powered-by')

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }))
app.use(express.urlencoded({ extended: false, limit: '2mb' }))

app.use(session({
  store: new PgSession({ pool: getPool(), tableName: 'user_sessions', createTableIfMissing: true }),
  name: 'ippms.sid',
  secret: process.env.SESSION_SECRET || 'ip-pms-development-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 8 * 60 * 60 * 1000
  }
}))

app.use(attachDb)
app.use(flash)
app.use(loadUser)

// Values every view needs
const helpers = require('./src/lib/view-helpers')
app.use((req, res, next) => {
  Object.assign(res.locals, helpers)
  res.locals.ipModules = Object.values(IP_MODULES)
  res.locals.activeNav = null
  res.locals.title = 'IP-PMS'
  res.locals.currentPath = req.path
  res.locals.query = req.query
  next()
})

app.use(require('./src/routes/auth'))
app.use(require('./src/routes/dashboard'))
app.use('/ip', require('./src/routes/ip'))
app.use('/docket', require('./src/routes/docket'))
app.use('/clients', require('./src/routes/clients'))
app.use('/users', require('./src/routes/users'))
app.use('/settings', require('./src/routes/settings'))
app.use('/audit', require('./src/routes/audit'))
app.use('/reports', require('./src/routes/reports'))
app.use('/import', require('./src/routes/imports'))
app.use('/platform', require('./src/routes/platform'))

app.use((req, res) => {
  res.status(404).render('pages/error', {
    title: 'Page not found',
    message: 'That page does not exist.'
  })
})

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err)
  res.status(500).render('pages/error', {
    title: 'Something went wrong',
    message: process.env.NODE_ENV === 'production'
      ? 'The action could not be completed. The error was logged.'
      : err.message
  })
})

async function start () {
  try {
    await migrate()
    await seed()
    archive.startScheduler()
  } catch (err) {
    console.error('[boot] database setup failed:', err.message)
  }

  const server = app.listen(port, () => console.log(`Listening on ${port}`))

  // Keep-alive must outlast the router's 90 second idle timeout.
  server.keepAliveTimeout = 95 * 1000

  process.on('SIGTERM', () => {
    console.log('SIGTERM received: shutting down')
    archive.stopScheduler()
    server.close(() => console.log('HTTP server closed'))
  })

  return server
}

if (require.main === module) {
  start()
}

module.exports = { app, start }
