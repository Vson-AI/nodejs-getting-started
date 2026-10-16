const { DbContext } = require('../db/pool')
const { can, isClient, isPlatformAdmin } = require('../lib/permissions')

/** Idle session limits. Client portal is 30 minutes (BR-28, NFR-017). */
const IDLE_LIMITS = { CLIENT: 30 * 60 * 1000, STAFF: 8 * 60 * 60 * 1000, PLATFORM_ADMIN: 8 * 60 * 60 * 1000 }

/**
 * Opens one database session per request carrying the RLS context of the
 * signed-in user, and releases it when the response is done.
 */
function attachDb (req, res, next) {
  const user = req.session && req.session.user
  req.db = new DbContext({
    tenantId: user ? user.tenantId : null,
    clientId: user ? user.clientId : null,
    userType: user ? user.userType : 'NONE',
    username: user ? user.username : 'anonymous'
  })
  let released = false
  const release = () => {
    if (released) return
    released = true
    req.db.release().catch((err) => console.error('[db] release failed', err.message))
  }
  res.on('finish', release)
  res.on('close', release)
  next()
}

/**
 * Re-reads the user and tenant on every request so that a deactivated user,
 * a deactivated client or a suspended tenant loses access immediately
 * (BR-01, UC-25, FR-CLI-009).
 */
async function loadUser (req, res, next) {
  const sessionUser = req.session && req.session.user
  if (!sessionUser) return next()

  const idleLimit = IDLE_LIMITS[sessionUser.userType] || IDLE_LIMITS.STAFF
  const lastSeen = req.session.lastSeen || 0
  if (lastSeen && Date.now() - lastSeen > idleLimit) {
    req.session.user = null
    req.session.flash = [{ type: 'warn', message: 'Your session timed out. Sign in again.' }]
    return res.redirect('/login')
  }
  req.session.lastSeen = Date.now()

  try {
    const row = await req.db.one(
      `SELECT u.id, u.username, u.full_name, u.email, u.user_type, u.status,
              u.tenant_id, u.client_id,
              t.legal_name AS tenant_name, t.initials AS tenant_initials, t.status AS tenant_status,
              cl.name AS client_name, cl.code AS client_code, cl.status AS client_status
         FROM users u
         LEFT JOIN tenants t ON t.id = u.tenant_id
         LEFT JOIN clients cl ON cl.id = u.client_id
        WHERE u.id = $1`,
      [sessionUser.id]
    )

    const problem = !row
      ? 'Your account no longer exists.'
      : row.status !== 'ACTIVE'
        ? 'Your account has been deactivated.'
        : row.tenant_id && row.tenant_status !== 'ACTIVE'
          ? 'This agency account is suspended.'
          : row.client_id && row.client_status !== 'ACTIVE'
            ? 'Your client account has been deactivated.'
            : null

    if (problem) {
      req.session.user = null
      req.session.flash = [{ type: 'error', message: problem }]
      return res.redirect('/login')
    }

    const roles = (await req.db.all('SELECT role FROM user_roles WHERE user_id = $1', [row.id]))
      .map((r) => r.role)

    // The database session now runs as this user (SRS section 9.1).
    await req.db.setContext({
      tenantId: row.tenant_id ? Number(row.tenant_id) : null,
      clientId: row.client_id ? Number(row.client_id) : null,
      userType: row.user_type,
      username: row.username
    })

    req.user = {
      id: Number(row.id),
      username: row.username,
      fullName: row.full_name,
      email: row.email,
      userType: row.user_type,
      tenantId: row.tenant_id ? Number(row.tenant_id) : null,
      clientId: row.client_id ? Number(row.client_id) : null,
      tenantName: row.tenant_name,
      tenantInitials: row.tenant_initials,
      clientName: row.client_name,
      clientCode: row.client_code,
      roles
    }
    res.locals.user = req.user
    res.locals.can = (permission) => can(req.user, permission)
    res.locals.isClient = isClient(req.user)
    res.locals.isPlatformAdmin = isPlatformAdmin(req.user)
    next()
  } catch (err) {
    next(err)
  }
}

function flash (req, res, next) {
  res.locals.flash = (req.session && req.session.flash) || []
  if (req.session) req.session.flash = []
  req.flash = (type, message) => {
    if (!req.session.flash) req.session.flash = []
    req.session.flash.push({ type, message })
  }
  next()
}

function requireAuth (req, res, next) {
  if (!req.user) {
    if (req.method === 'GET') req.session.returnTo = req.originalUrl
    return res.redirect('/login')
  }
  next()
}

function requireTenant (req, res, next) {
  if (!req.user) return res.redirect('/login')
  if (!req.user.tenantId) {
    return res.status(403).render('pages/error', {
      title: 'Not available',
      message: 'Platform administrators do not have access to tenant data (SRS section 11).'
    })
  }
  next()
}

function requirePermission (permission) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login')
    if (!can(req.user, permission)) {
      return res.status(403).render('pages/error', {
        title: 'Access denied',
        message: `Your role does not allow this action (${permission}).`
      })
    }
    next()
  }
}

function requirePlatformAdmin (req, res, next) {
  if (!req.user) return res.redirect('/login')
  if (!isPlatformAdmin(req.user)) {
    return res.status(403).render('pages/error', {
      title: 'Access denied',
      message: 'This area is for platform administrators.'
    })
  }
  next()
}

module.exports = {
  attachDb,
  loadUser,
  flash,
  requireAuth,
  requireTenant,
  requirePermission,
  requirePlatformAdmin,
  IDLE_LIMITS
}
