const express = require('express')
const bcrypt = require('bcryptjs')
const { withContext } = require('../db/pool')
const { validateInitials, validatePassword } = require('../lib/validate')
const { randomToken } = require('../lib/crypto')
const { writeAudit } = require('../lib/audit')
const archive = require('../lib/archive')
const { IP_MODULES } = require('../lib/modules')
const { requireAuth, requirePlatformAdmin } = require('../middleware/context')

const router = express.Router()

router.use(requireAuth, requirePlatformAdmin)

/**
 * Platform operations touch rows in several tenants, so they run in a
 * maintenance context instead of a single tenant context. This is the only
 * request path that does so, and it never reads IP data (SRS section 11).
 */
function asPlatform (req, fn) {
  return withContext(
    { tenantId: null, userType: 'PLATFORM_ADMIN', username: req.user.username, bypass: true },
    fn
  )
}

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) {
    return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown tenant.' })
  }
  next()
})

router.get('/', async (req, res, next) => {
  try {
    const tenants = await req.db.all(
      `SELECT t.*, p.name AS plan_name,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.user_type = 'STAFF') AS staff_count,
              (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.user_type = 'CLIENT') AS portal_count,
              (SELECT count(*) FROM clients c WHERE c.tenant_id = t.id AND c.status <> 'DELETED') AS client_count
         FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id
        ORDER BY t.legal_name`
    )
    const lastArchive = await asPlatform(req, (db) => archive.lastRun(db))
    const recentLogins = await req.db.all(
      `SELECT l.*, t.initials FROM login_events l
         LEFT JOIN tenants t ON t.id = l.tenant_id
        ORDER BY l.created_at DESC LIMIT 15`
    )
    res.render('pages/platform', {
      title: 'Platform console',
      activeNav: 'platform',
      tenants,
      lastArchive,
      recentLogins,
      retentionYears: archive.RETENTION_YEARS,
      newAccount: (() => { const a = req.session.newAccount; req.session.newAccount = null; return a })()
    })
  } catch (err) { next(err) }
})

router.get('/tenants/new', async (req, res, next) => {
  try {
    const plans = await req.db.all('SELECT * FROM plans ORDER BY id')
    res.render('pages/tenant-form', {
      title: 'Provision a tenant', activeNav: 'platform', plans, values: {}, errors: []
    })
  } catch (err) { next(err) }
})

/** UC-19: provision a tenant, seed its settings and counters, create its admin. */
router.post('/tenants', async (req, res, next) => {
  try {
    const legalName = String(req.body.legal_name || '').trim()
    const { value: initials, error: initialsError } = validateInitials(req.body.initials)
    const contactEmail = String(req.body.contact_email || '').trim() || null
    const contactPhone = String(req.body.contact_phone || '').trim() || null
    const planId = req.body.plan_id ? Number(req.body.plan_id) : null
    const adminUser = String(req.body.admin_username || '').trim()
    let adminPassword = String(req.body.admin_password || '').trim()
    if (!adminPassword) adminPassword = randomToken(6) + '5e'

    const errors = []
    if (legalName.length < 2) errors.push({ column: 'legal_name', message: 'Legal name is required' })
    if (initialsError) errors.push({ column: 'initials', message: initialsError })
    if (!/^[A-Za-z0-9._-]{3,100}$/.test(adminUser)) {
      errors.push({ column: 'admin_username', message: 'Administrator username must be 3 to 100 letters, digits, dot, hyphen or underscore' })
    }
    const passwordProblem = validatePassword(adminPassword)
    if (passwordProblem) errors.push({ column: 'admin_password', message: passwordProblem })

    const clash = await req.db.one(
      'SELECT id FROM tenants WHERE initials = $1 OR lower(legal_name) = lower($2)',
      [initials, legalName])
    if (clash) errors.push({ column: 'initials', message: 'Those initials or that legal name are already taken' })

    if (errors.length > 0) {
      const plans = await req.db.all('SELECT * FROM plans ORDER BY id')
      return res.status(400).render('pages/tenant-form', {
        title: 'Provision a tenant', activeNav: 'platform', plans, values: req.body, errors
      })
    }

    const hash = await bcrypt.hash(adminPassword, 12)
    const tenant = await asPlatform(req, (db) => db.tx(async (tx) => {
      const row = await tx.one(
        `INSERT INTO tenants (legal_name, initials, contact_email, contact_phone, plan_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [legalName, initials, contactEmail, contactPhone, planId]
      )
      await tx.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [row.id])
      for (const code of ['P', 'U', 'M', 'C', 'D']) {
        await tx.query(
          'INSERT INTO ref_counters (tenant_id, type_code, last_value) VALUES ($1,$2,0)',
          [row.id, code])
      }
      const admin = await tx.one(
        `INSERT INTO users (tenant_id, username, full_name, email, password_hash, user_type, must_change_password)
         VALUES ($1,$2,$3,$4,$5,'STAFF',TRUE) RETURNING id`,
        [row.id, adminUser, 'Tenant administrator', contactEmail, hash]
      )
      await tx.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [admin.id, 'ADMIN'])
      return row
    }))

    req.session.newAccount = { username: adminUser, password: adminPassword, agency: initials }
    req.flash('ok', `${tenant.legal_name} provisioned with initials ${tenant.initials}.`)
    res.redirect(`/platform/tenants/${tenant.id}`)
  } catch (err) { next(err) }
})

router.get('/tenants/:id', async (req, res, next) => {
  try {
    const tenant = await req.db.one('SELECT * FROM tenants WHERE id = $1', [Number(req.params.id)])
    if (!tenant) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown tenant.' })
    const users = await req.db.all(
      `SELECT u.id, u.username, u.full_name, u.user_type, u.status, u.last_login_at,
              COALESCE(string_agg(r.role, ', '), '') AS roles
         FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
        WHERE u.tenant_id = $1 GROUP BY u.id ORDER BY u.user_type, u.username`,
      [tenant.id])
    const counters = await req.db.all(
      'SELECT type_code, last_value FROM ref_counters WHERE tenant_id = $1 ORDER BY type_code',
      [tenant.id])
    const counts = await asPlatform(req, async (db) => {
      const out = {}
      for (const mod of Object.values(IP_MODULES)) {
        out[mod.plural] = Number(
          await db.value(`SELECT count(*) FROM ${mod.table} WHERE tenant_id = $1`, [tenant.id]))
      }
      return out
    })
    res.render('pages/tenant-detail', {
      title: tenant.legal_name,
      activeNav: 'platform',
      tenant,
      users,
      counters,
      counts,
      newAccount: (() => { const a = req.session.newAccount; req.session.newAccount = null; return a })()
    })
  } catch (err) { next(err) }
})

/** UC-25: suspend or reactivate a tenant. Sessions check status on every request. */
router.post('/tenants/:id/status', async (req, res, next) => {
  try {
    const target = req.body.status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED'
    const tenant = await asPlatform(req, (db) => db.one(
      'UPDATE tenants SET status = $2 WHERE id = $1 RETURNING *', [Number(req.params.id), target]))
    if (!tenant) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown tenant.' })
    req.flash('ok', target === 'ACTIVE'
      ? `${tenant.legal_name} reactivated.`
      : `${tenant.legal_name} suspended. Its users are signed out on their next request.`)
    res.redirect(`/platform/tenants/${tenant.id}`)
  } catch (err) { next(err) }
})

/** Add another administrator to a tenant (FR-AUTH-006). */
router.post('/tenants/:id/admins', async (req, res, next) => {
  try {
    const tenant = await req.db.one('SELECT * FROM tenants WHERE id = $1', [Number(req.params.id)])
    if (!tenant) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown tenant.' })
    const username = String(req.body.username || '').trim()
    let password = String(req.body.password || '').trim()
    if (!password) password = randomToken(6) + '3f'

    const problems = []
    if (!/^[A-Za-z0-9._-]{3,100}$/.test(username)) problems.push('Username is not valid')
    const passwordProblem = validatePassword(password)
    if (passwordProblem) problems.push(passwordProblem)
    const taken = await req.db.one(
      'SELECT id FROM users WHERE tenant_id = $1 AND lower(username) = lower($2)', [tenant.id, username])
    if (taken) problems.push('That username already exists in this tenant')
    if (problems.length > 0) {
      req.flash('error', problems.join('. '))
      return res.redirect(`/platform/tenants/${tenant.id}`)
    }

    const hash = await bcrypt.hash(password, 12)
    await asPlatform(req, (db) => db.tx(async (tx) => {
      const row = await tx.one(
        `INSERT INTO users (tenant_id, username, full_name, password_hash, user_type, must_change_password)
         VALUES ($1,$2,'Tenant administrator',$3,'STAFF',TRUE) RETURNING id`,
        [tenant.id, username, hash])
      await tx.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [row.id, 'ADMIN'])
    }))
    req.session.newAccount = { username, password, agency: tenant.initials }
    req.flash('ok', `Administrator ${username} added to ${tenant.legal_name}.`)
    res.redirect(`/platform/tenants/${tenant.id}`)
  } catch (err) { next(err) }
})

/** Hard delete, the one deletion a tenant admin cannot do (FR-TEN-008). */
router.post('/tenants/:id/delete', async (req, res, next) => {
  try {
    const tenant = await req.db.one('SELECT * FROM tenants WHERE id = $1', [Number(req.params.id)])
    if (!tenant) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown tenant.' })
    if (String(req.body.confirm || '').toUpperCase() !== tenant.initials) {
      req.flash('error', 'Type the tenant initials to confirm a hard delete.')
      return res.redirect(`/platform/tenants/${tenant.id}`)
    }
    await asPlatform(req, (db) => db.tx(async (tx) => {
      await tx.query('DELETE FROM audit_logs WHERE tenant_id = $1', [tenant.id])
      await tx.query('DELETE FROM audit_logs_archive WHERE tenant_id = $1', [tenant.id])
      await tx.query('DELETE FROM tenants WHERE id = $1', [tenant.id])
    }))
    req.flash('ok', `${tenant.legal_name} and all of its data were deleted.`)
    res.redirect('/platform')
  } catch (err) { next(err) }
})

/** Run the audit archive now instead of waiting for the monthly schedule. */
router.post('/archive', async (req, res, next) => {
  try {
    const moved = await archive.runArchive()
    req.flash('ok', `Audit archive run: ${moved} row(s) older than ${archive.RETENTION_YEARS} years moved.`)
    res.redirect('/platform')
  } catch (err) { next(err) }
})

/** Platform admins may reset their own password and manage their peers. */
router.post('/admins', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim()
    let password = String(req.body.password || '').trim()
    if (!password) password = randomToken(6) + '8h'
    const problems = []
    if (!/^[A-Za-z0-9._-]{3,100}$/.test(username)) problems.push('Username is not valid')
    const passwordProblem = validatePassword(password)
    if (passwordProblem) problems.push(passwordProblem)
    const taken = await req.db.one(
      'SELECT id FROM users WHERE tenant_id IS NULL AND lower(username) = lower($1)', [username])
    if (taken) problems.push('That platform username already exists')
    if (problems.length > 0) {
      req.flash('error', problems.join('. '))
      return res.redirect('/platform')
    }
    const hash = await bcrypt.hash(password, 12)
    await asPlatform(req, (db) => db.tx(async (tx) => {
      const row = await tx.one(
        `INSERT INTO users (username, full_name, password_hash, user_type, must_change_password)
         VALUES ($1,'Platform administrator',$2,'PLATFORM_ADMIN',TRUE) RETURNING id`,
        [username, hash])
      await tx.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [row.id, 'PLATFORM_ADMIN'])
      await writeAudit(tx, {
        tenantId: 0,
        username: req.user.username,
        action: 'CREATE',
        module: 'USER',
        recordRef: username
      })
    }))
    req.session.newAccount = { username, password }
    req.flash('ok', `Platform administrator ${username} created.`)
    res.redirect('/platform')
  } catch (err) { next(err) }
})

module.exports = router
