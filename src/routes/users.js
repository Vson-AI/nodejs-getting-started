const express = require('express')
const bcrypt = require('bcryptjs')
const { validatePassword } = require('../lib/validate')
const { randomToken } = require('../lib/crypto')
const { writeAudit } = require('../lib/audit')
const { requireAuth, requireTenant, requirePermission } = require('../middleware/context')

const router = express.Router()
const STAFF_ROLES = ['ADMIN', 'EXAMINER', 'VIEWER', 'AUDITOR']

router.use(requireAuth, requireTenant, requirePermission('user.manage'))

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) {
    return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown user.' })
  }
  next()
})

async function listUsers (db, tenantId) {
  return db.all(
    `SELECT u.id, u.username, u.full_name, u.email, u.user_type, u.status, u.last_login_at,
            c.name AS client_name,
            COALESCE(string_agg(r.role, ', ' ORDER BY r.role), '') AS roles
       FROM users u
       LEFT JOIN clients c ON c.id = u.client_id
       LEFT JOIN user_roles r ON r.user_id = u.id
      WHERE u.tenant_id = $1
      GROUP BY u.id, c.name
      ORDER BY u.user_type, u.username`,
    [tenantId]
  )
}

router.get('/', async (req, res, next) => {
  try {
    res.render('pages/users', {
      title: 'Users',
      activeNav: 'users',
      users: await listUsers(req.db, req.user.tenantId),
      staffRoles: STAFF_ROLES,
      newAccount: (() => { const a = req.session.newAccount; req.session.newAccount = null; return a })()
    })
  } catch (err) { next(err) }
})

router.get('/new', (req, res) => {
  res.render('pages/user-form', {
    title: 'New user', activeNav: 'users', target: null, values: {}, roles: ['EXAMINER'],
    staffRoles: STAFF_ROLES, errors: []
  })
})

router.post('/', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim()
    const fullName = String(req.body.full_name || '').trim() || null
    const email = String(req.body.email || '').trim() || null
    let password = String(req.body.password || '').trim()
    if (!password) password = randomToken(6) + '2c'
    const roles = [].concat(req.body.roles || []).filter((r) => STAFF_ROLES.includes(r))

    const errors = []
    if (!/^[A-Za-z0-9._-]{3,100}$/.test(username)) {
      errors.push({ column: 'username', message: 'Username must be 3 to 100 letters, digits, dot, hyphen or underscore' })
    }
    const passwordProblem = validatePassword(password)
    if (passwordProblem) errors.push({ column: 'password', message: passwordProblem })
    if (roles.length === 0) errors.push({ column: 'roles', message: 'Choose at least one role' })
    const taken = await req.db.one(
      'SELECT id FROM users WHERE tenant_id = $1 AND lower(username) = lower($2)',
      [req.user.tenantId, username])
    if (taken) errors.push({ column: 'username', message: 'That username is already used in this tenant' })

    if (errors.length > 0) {
      return res.status(400).render('pages/user-form', {
        title: 'New user', activeNav: 'users', target: null, values: req.body, roles,
        staffRoles: STAFF_ROLES, errors
      })
    }

    const hash = await bcrypt.hash(password, 12)
    const created = await req.db.tx(async (tx) => {
      const row = await tx.one(
        `INSERT INTO users (tenant_id, username, full_name, email, password_hash, user_type, must_change_password)
         VALUES ($1,$2,$3,$4,$5,'STAFF',TRUE) RETURNING id, username`,
        [req.user.tenantId, username, fullName, email, hash]
      )
      for (const role of roles) {
        await tx.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [row.id, role])
      }
      return row
    })
    req.session.newAccount = { username: created.username, password }
    req.flash('ok', `User ${created.username} created.`)
    res.redirect('/users')
  } catch (err) { next(err) }
})

router.get('/:id/edit', async (req, res, next) => {
  try {
    const target = await req.db.one(
      'SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [Number(req.params.id), req.user.tenantId])
    if (!target) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown user.' })
    const roles = (await req.db.all('SELECT role FROM user_roles WHERE user_id = $1', [target.id]))
      .map((r) => r.role)
    res.render('pages/user-form', {
      title: `Edit ${target.username}`, activeNav: 'users', target, values: target, roles,
      staffRoles: STAFF_ROLES, errors: []
    })
  } catch (err) { next(err) }
})

router.post('/:id', async (req, res, next) => {
  try {
    const target = await req.db.one(
      'SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [Number(req.params.id), req.user.tenantId])
    if (!target) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown user.' })

    const fullName = String(req.body.full_name || '').trim() || null
    const email = String(req.body.email || '').trim() || null
    const status = req.body.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
    const roles = [].concat(req.body.roles || []).filter((r) => STAFF_ROLES.includes(r))

    await req.db.tx(async (tx) => {
      await tx.query(
        'UPDATE users SET full_name = $2, email = $3, status = $4 WHERE id = $1',
        [target.id, fullName, email, status]
      )
      // BR-10: a user cannot change their own role
      if (target.id !== req.user.id && target.user_type === 'STAFF' && roles.length > 0) {
        await tx.query('DELETE FROM user_roles WHERE user_id = $1', [target.id])
        for (const role of roles) {
          await tx.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [target.id, role])
        }
      }
    })
    req.flash('ok', target.id === req.user.id
      ? 'Your details were updated. Roles can only be changed by another administrator (BR-10).'
      : `${target.username} updated.`)
    res.redirect('/users')
  } catch (err) { next(err) }
})

router.post('/:id/password', async (req, res, next) => {
  try {
    const password = randomToken(6) + '9d'
    const hash = await bcrypt.hash(password, 12)
    const row = await req.db.one(
      `UPDATE users SET password_hash = $3, must_change_password = TRUE
        WHERE id = $1 AND tenant_id = $2 RETURNING username`,
      [Number(req.params.id), req.user.tenantId, hash]
    )
    if (!row) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown user.' })
    await writeAudit(req.db, {
      tenantId: req.user.tenantId,
      username: req.user.username,
      action: 'RESET_PASSWORD',
      module: 'USER',
      recordId: Number(req.params.id),
      recordRef: row.username
    })
    req.session.newAccount = { username: row.username, password }
    req.flash('ok', 'Password reset.')
    res.redirect('/users')
  } catch (err) { next(err) }
})

module.exports = router
