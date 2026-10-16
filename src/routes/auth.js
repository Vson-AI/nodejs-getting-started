const express = require('express')
const bcrypt = require('bcryptjs')
const { writeAudit } = require('../lib/audit')
const { validatePassword } = require('../lib/validate')
const { requireAuth } = require('../middleware/context')

const router = express.Router()

async function brandingFor (db, agency) {
  if (!agency) return null
  const tenant = await db.one(
    `SELECT t.id, t.legal_name, t.initials, t.status, s.brand_logo_url
       FROM tenants t LEFT JOIN tenant_settings s ON s.tenant_id = t.id
      WHERE t.initials = $1`,
    [String(agency).toUpperCase()]
  )
  return tenant
}

async function logLogin (db, { tenantId, username, succeeded, reason, ip }) {
  await db.query(
    `INSERT INTO login_events (tenant_id, username, succeeded, reason, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId || null, username || null, succeeded, reason || null, ip || null]
  )
}

router.get('/login', async (req, res, next) => {
  try {
    if (req.user) return res.redirect('/')
    const branding = await brandingFor(req.db, req.query.agency)
    res.render('pages/login', {
      title: 'Sign in',
      agency: req.query.agency || '',
      username: '',
      branding,
      error: null
    })
  } catch (err) { next(err) }
})

router.get('/portal/:agency', (req, res) => {
  res.redirect('/login?agency=' + encodeURIComponent(req.params.agency.toUpperCase()))
})

router.post('/login', async (req, res, next) => {
  const agency = String(req.body.agency || '').trim().toUpperCase()
  const username = String(req.body.username || '').trim()
  const password = String(req.body.password || '')
  const ip = req.ip

  const fail = async (message, tenantId) => {
    await logLogin(req.db, { tenantId, username, succeeded: false, reason: message, ip })
    const branding = await brandingFor(req.db, agency)
    res.status(401).render('pages/login', {
      title: 'Sign in',
      agency,
      username,
      branding,
      error: message
    })
  }

  try {
    let tenant = null
    if (agency) {
      tenant = await brandingFor(req.db, agency)
      if (!tenant) return await fail('Agency code not recognised')
      if (tenant.status !== 'ACTIVE') {
        return await fail('This agency account is suspended', tenant.id)
      }
    }

    const user = tenant
      ? await req.db.one(
        'SELECT * FROM users WHERE tenant_id = $1 AND lower(username) = lower($2)',
        [tenant.id, username])
      : await req.db.one(
        'SELECT * FROM users WHERE tenant_id IS NULL AND lower(username) = lower($1)',
        [username])

    if (!user) return await fail('Username or password is incorrect', tenant && tenant.id)
    if (user.status !== 'ACTIVE') return await fail('This account is deactivated', user.tenant_id)

    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) return await fail('Username or password is incorrect', user.tenant_id)

    if (user.client_id) {
      const client = await req.db.one('SELECT status FROM clients WHERE id = $1', [user.client_id])
      if (!client || client.status !== 'ACTIVE') {
        return await fail('This client account is deactivated', user.tenant_id)
      }
    }

    // Adopt the user's RLS context before any write, so the audit triggers
    // fired by the statements below land in the right tenant.
    await req.db.query(
      `SELECT set_config('app.tenant_id', $1, false),
              set_config('app.client_id', $2, false),
              set_config('app.user_type', $3, false),
              set_config('app.username',  $4, false)`,
      [
        user.tenant_id ? String(user.tenant_id) : '0',
        user.client_id ? String(user.client_id) : '',
        user.user_type,
        user.username
      ]
    )

    await req.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])
    await logLogin(req.db, { tenantId: user.tenant_id, username, succeeded: true, ip })

    // Audit the login against the tenant and the client (FR-CP-010)
    if (user.tenant_id) {
      await writeAudit(req.db, {
        tenantId: Number(user.tenant_id),
        clientId: user.client_id ? Number(user.client_id) : null,
        username: user.username,
        action: 'LOGIN',
        module: 'AUTH',
        recordId: Number(user.id),
        recordRef: user.username
      })
    }

    const returnTo = req.session.returnTo
    req.session.regenerate((err) => {
      if (err) return next(err)
      req.session.user = {
        id: Number(user.id),
        username: user.username,
        userType: user.user_type,
        tenantId: user.tenant_id ? Number(user.tenant_id) : null,
        clientId: user.client_id ? Number(user.client_id) : null
      }
      req.session.lastSeen = Date.now()
      req.session.save(() => res.redirect(returnTo || '/'))
    })
  } catch (err) { next(err) }
})

router.post('/logout', (req, res) => {
  const agency = req.user && req.user.tenantInitials
  req.session.destroy(() => {
    res.redirect(agency ? `/login?agency=${encodeURIComponent(agency)}` : '/login')
  })
})

router.get('/account', requireAuth, (req, res) => {
  res.render('pages/account', { title: 'My account', activeNav: 'account', error: null })
})

router.post('/account/password', requireAuth, async (req, res, next) => {
  try {
    const current = String(req.body.current_password || '')
    const next1 = String(req.body.new_password || '')
    const confirm = String(req.body.confirm_password || '')

    const row = await req.db.one('SELECT password_hash FROM users WHERE id = $1', [req.user.id])
    const ok = await bcrypt.compare(current, row.password_hash)
    let error = null
    if (!ok) error = 'Your current password is not correct'
    else if (next1 !== confirm) error = 'The new passwords do not match'
    else error = validatePassword(next1)

    if (error) {
      return res.status(400).render('pages/account', { title: 'My account', activeNav: 'account', error })
    }
    const hash = await bcrypt.hash(next1, 12)
    await req.db.query(
      'UPDATE users SET password_hash = $2, must_change_password = FALSE WHERE id = $1',
      [req.user.id, hash]
    )
    req.flash('ok', 'Password changed.')
    res.redirect('/account')
  } catch (err) { next(err) }
})

module.exports = router
