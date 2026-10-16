const express = require('express')
const bcrypt = require('bcryptjs')
const records = require('../lib/records')
const reports = require('../lib/reports')
const { validatePassword } = require('../lib/validate')
const { randomToken } = require('../lib/crypto')
const { writeAudit } = require('../lib/audit')
const { requireAuth, requireTenant, requirePermission } = require('../middleware/context')

const router = express.Router()

router.use(requireAuth, requireTenant, requirePermission('client.manage'))

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) {
    return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown client.' })
  }
  next()
})

async function loadClient (req, id) {
  return req.db.one(
    `SELECT * FROM clients WHERE id = $1 AND tenant_id = $2 AND status <> 'DELETED'`,
    [Number(id), req.user.tenantId]
  )
}

function readForm (body) {
  const pick = (k) => (body[k] == null ? null : String(body[k]).trim() || null)
  return {
    code: (pick('code') || '').toUpperCase() || null,
    name: pick('name'),
    contact_person: pick('contact_person'),
    email: pick('email'),
    phone: pick('phone'),
    address: pick('address'),
    tax_number: pick('tax_number'),
    notes: pick('notes')
  }
}

function validateClient (values) {
  const errors = []
  if (!values.code) errors.push({ column: 'code', message: 'Client code is required' })
  else if (!/^[A-Z0-9_-]{2,30}$/.test(values.code)) {
    errors.push({ column: 'code', message: 'Client code must be 2 to 30 letters, digits, hyphen or underscore' })
  }
  if (!values.name) errors.push({ column: 'name', message: 'Client name is required' })
  if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) {
    errors.push({ column: 'email', message: 'Email address is not valid' })
  }
  return errors
}

// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const clients = await req.db.all(
      `SELECT c.*,
              (SELECT count(*) FROM users u WHERE u.client_id = c.id AND u.user_type = 'CLIENT') AS portal_accounts
         FROM clients c
        WHERE c.tenant_id = $1 AND c.status <> 'DELETED'
        ORDER BY c.name`,
      [req.user.tenantId]
    )
    const totals = await reports.clientTotals(req.db, req.user.tenantId)
    res.render('pages/clients', {
      title: 'Clients',
      activeNav: 'clients',
      clients,
      totals
    })
  } catch (err) { next(err) }
})

router.get('/new', (req, res) => {
  res.render('pages/client-form', {
    title: 'New client', activeNav: 'clients', client: null, values: {}, errors: []
  })
})

router.post('/', async (req, res, next) => {
  try {
    const values = readForm(req.body)
    const errors = validateClient(values)
    const clash = values.code && await req.db.one(
      'SELECT id FROM clients WHERE tenant_id = $1 AND code = $2',
      [req.user.tenantId, values.code]
    )
    if (clash) errors.push({ column: 'code', message: 'That client code is already used in this tenant' })

    if (errors.length > 0) {
      return res.status(400).render('pages/client-form', {
        title: 'New client', activeNav: 'clients', client: null, values: req.body, errors
      })
    }
    const created = await req.db.one(
      `INSERT INTO clients (tenant_id, code, name, contact_person, email, phone, address, tax_number, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.tenantId, values.code, values.name, values.contact_person, values.email,
        values.phone, values.address, values.tax_number, values.notes]
    )
    req.flash('ok', `Client ${created.code} created.`)
    res.redirect(`/clients/${created.id}`)
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const client = await loadClient(req, req.params.id)
    if (!client) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown client.' })
    const accounts = await req.db.all(
      `SELECT id, username, full_name, email, status, last_login_at, must_change_password
         FROM users WHERE client_id = $1 ORDER BY username`,
      [client.id]
    )
    const portfolio = await reports.clientPortfolio(req.db, req.user.tenantId, client.id)
    res.render('pages/client-detail', {
      title: client.name,
      activeNav: 'clients',
      client,
      accounts,
      portfolio,
      newAccount: req.session.newAccount || null
    })
    req.session.newAccount = null
  } catch (err) { next(err) }
})

router.get('/:id/edit', async (req, res, next) => {
  try {
    const client = await loadClient(req, req.params.id)
    if (!client) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown client.' })
    res.render('pages/client-form', {
      title: `Edit ${client.name}`, activeNav: 'clients', client, values: client, errors: []
    })
  } catch (err) { next(err) }
})

router.post('/:id', async (req, res, next) => {
  try {
    const client = await loadClient(req, req.params.id)
    if (!client) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown client.' })
    const values = readForm(req.body)
    const errors = validateClient(values)
    const clash = values.code && await req.db.one(
      'SELECT id FROM clients WHERE tenant_id = $1 AND code = $2 AND id <> $3',
      [req.user.tenantId, values.code, client.id]
    )
    if (clash) errors.push({ column: 'code', message: 'That client code is already used in this tenant' })

    if (errors.length > 0) {
      return res.status(400).render('pages/client-form', {
        title: `Edit ${client.name}`, activeNav: 'clients', client, values: req.body, errors
      })
    }
    await req.db.query(
      `UPDATE clients SET code=$2, name=$3, contact_person=$4, email=$5, phone=$6,
              address=$7, tax_number=$8, notes=$9
        WHERE id = $1`,
      [client.id, values.code, values.name, values.contact_person, values.email,
        values.phone, values.address, values.tax_number, values.notes]
    )
    req.flash('ok', 'Client updated.')
    res.redirect(`/clients/${client.id}`)
  } catch (err) { next(err) }
})

/** Deactivating a client disables its portal accounts (BR-24) but keeps links (BR-25). */
router.post('/:id/status', async (req, res, next) => {
  try {
    const client = await loadClient(req, req.params.id)
    if (!client) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown client.' })
    const target = req.body.status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED'
    await req.db.tx(async (tx) => {
      await tx.query('UPDATE clients SET status = $2 WHERE id = $1', [client.id, target])
      if (target === 'SUSPENDED') {
        await tx.query(
          `UPDATE users SET status = 'INACTIVE' WHERE client_id = $1 AND user_type = 'CLIENT'`,
          [client.id]
        )
      }
    })
    req.flash('ok', target === 'ACTIVE'
      ? 'Client reactivated. Portal accounts stay disabled until you enable them.'
      : 'Client deactivated and its portal accounts disabled. IP records keep their link.')
    res.redirect(`/clients/${client.id}`)
  } catch (err) { next(err) }
})

/** Soft delete (FR-CLI-010). A hard delete is a platform admin action. */
router.post('/:id/delete', async (req, res, next) => {
  try {
    const client = await loadClient(req, req.params.id)
    if (!client) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown client.' })
    await req.db.tx(async (tx) => {
      await tx.query(
        `UPDATE clients SET status = 'DELETED', deleted_at = now() WHERE id = $1`, [client.id]
      )
      await tx.query(
        `UPDATE users SET status = 'INACTIVE' WHERE client_id = $1 AND user_type = 'CLIENT'`,
        [client.id]
      )
    })
    req.flash('ok', `Client ${client.code} removed. Records keep their history.`)
    res.redirect('/clients')
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------------------
// Portal accounts (UC-27, FR-CLI-004 .. 006, FR-CP-012)
// ---------------------------------------------------------------------------
router.post('/:id/accounts', async (req, res, next) => {
  try {
    const client = await loadClient(req, req.params.id)
    if (!client) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown client.' })

    const username = String(req.body.username || '').trim()
    const email = String(req.body.email || '').trim() || null
    const fullName = String(req.body.full_name || '').trim() || null
    let password = String(req.body.password || '').trim()
    if (!password) password = randomToken(6) + '7a'

    const problems = []
    if (!/^[A-Za-z0-9._-]{3,100}$/.test(username)) {
      problems.push('Username must be 3 to 100 letters, digits, dot, hyphen or underscore')
    }
    const passwordProblem = validatePassword(password)
    if (passwordProblem) problems.push(passwordProblem)
    const taken = await req.db.one(
      'SELECT id FROM users WHERE tenant_id = $1 AND lower(username) = lower($2)',
      [req.user.tenantId, username]
    )
    if (taken) problems.push('That username is already used in this tenant')

    if (problems.length > 0) {
      req.flash('error', problems.join('. '))
      return res.redirect(`/clients/${client.id}`)
    }

    const hash = await bcrypt.hash(password, 12)
    const created = await req.db.tx(async (tx) => {
      const row = await tx.one(
        `INSERT INTO users (tenant_id, client_id, username, full_name, email,
                            password_hash, user_type, must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,'CLIENT',TRUE) RETURNING id, username`,
        [req.user.tenantId, client.id, username, fullName, email, hash]
      )
      await tx.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [row.id, 'CLIENT'])
      return row
    })

    req.session.newAccount = { username: created.username, password }
    req.flash('ok', `Portal account ${created.username} created.`)
    res.redirect(`/clients/${client.id}`)
  } catch (err) { next(err) }
})

router.post('/:id/accounts/:userId/status', async (req, res, next) => {
  try {
    const target = req.body.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'
    await req.db.query(
      `UPDATE users SET status = $3
        WHERE id = $1 AND client_id = $2 AND tenant_id = $4`,
      [Number(req.params.userId), Number(req.params.id), target, req.user.tenantId]
    )
    req.flash('ok', target === 'ACTIVE' ? 'Portal account enabled.' : 'Portal account revoked.')
    res.redirect(`/clients/${req.params.id}`)
  } catch (err) { next(err) }
})

router.post('/:id/accounts/:userId/password', async (req, res, next) => {
  try {
    const password = randomToken(6) + '4b'
    const hash = await bcrypt.hash(password, 12)
    const row = await req.db.one(
      `UPDATE users SET password_hash = $3, must_change_password = TRUE
        WHERE id = $1 AND client_id = $2 RETURNING username`,
      [Number(req.params.userId), Number(req.params.id), hash]
    )
    if (row) {
      await writeAudit(req.db, {
        tenantId: req.user.tenantId,
        clientId: Number(req.params.id),
        username: req.user.username,
        action: 'RESET_PASSWORD',
        module: 'USER',
        recordId: Number(req.params.userId),
        recordRef: row.username
      })
      req.session.newAccount = { username: row.username, password }
    }
    req.flash('ok', 'Password reset.')
    res.redirect(`/clients/${req.params.id}`)
  } catch (err) { next(err) }
})

module.exports = router
