const express = require('express')
const { DOCKET_MODULE, csvColumns, IP_MODULES } = require('../lib/modules')
const records = require('../lib/records')
const { validateRecord } = require('../lib/validate')
const { formatCsv } = require('../lib/csv')
const { rowToCsv } = require('../lib/importer')
const { writeAudit, queryAudit } = require('../lib/audit')
const { requireAuth, requireTenant, requirePermission } = require('../middleware/context')

const router = express.Router()
const mod = DOCKET_MODULE

router.use((req, res, next) => {
  res.locals.mod = mod
  next()
})

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) {
    return res.status(404).render('pages/error', {
      title: 'Not found', message: 'That docket reference is not valid.'
    })
  }
  next()
})

function readFilters (query) {
  return {
    search: (query.q || '').trim() || null,
    ipType: query.ip_type || null,
    status: query.status || null,
    priority: query.priority || null,
    assignedTo: query.assigned_to || null,
    clientId: query.client || null,
    completed: query.completed || null,
    dueFrom: query.from || null,
    dueTo: query.to || null,
    overdue: query.view === 'overdue' ? true : null,
    upcomingDays: query.view === 'upcoming' ? Number(query.days) || 30 : null
  }
}

function normalizeBody (body) {
  const out = { ...body }
  for (const field of mod.fields) {
    if (Array.isArray(out[field.name])) out[field.name] = out[field.name].join(';')
  }
  return out
}

async function formContext (req) {
  const statuses = await records.getStatuses(req.db, req.user.tenantId, 'docket')
  const clients = await records.getClients(req.db, req.user.tenantId)
  const users = await req.db.all(
    `SELECT username, full_name FROM users
      WHERE tenant_id = $1 AND status = 'ACTIVE' AND user_type = 'STAFF' ORDER BY username`,
    [req.user.tenantId])
  return { statuses, clients, assignees: users, ipModules: Object.values(IP_MODULES) }
}

/** Resolve the linked IP record and inherit its client (FR-DOC-008). */
async function resolveLink (req, values) {
  if (values.ip_type && values.ip_record_ref) {
    const linked = await records.findIpByRef(req.db, req.user.tenantId, values.ip_type, values.ip_record_ref)
    if (!linked) {
      return { error: { column: 'ip_record_ref', message: `No ${values.ip_type} with reference "${values.ip_record_ref}"` } }
    }
    values.ip_record_id = linked.id
    if (values.client_id == null) values.client_id = linked.client_id
  } else {
    values.ip_record_id = null
  }
  return { error: null }
}

// ---------------------------------------------------------------------------
router.get('/', requireAuth, requireTenant, async (req, res, next) => {
  try {
    const filters = readFilters(req.query)
    const limit = 25
    const offset = (Math.max(Number(req.query.page) || 1, 1) - 1) * limit
    const list = await records.listDocket(req.db, req.user.tenantId, filters,
      { limit, offset, sort: req.query.sort, dir: req.query.dir })
    const statuses = await records.getStatuses(req.db, req.user.tenantId, 'docket')
    const clients = await records.getClients(req.db, req.user.tenantId)
    res.render('pages/docket-list', {
      title: 'Docket',
      activeNav: 'docket',
      list,
      statuses,
      clients,
      filters: req.query,
      page: Math.max(Number(req.query.page) || 1, 1)
    })
  } catch (err) { next(err) }
})

router.get('/export.csv', requireAuth, requireTenant,
  requirePermission('data.export'), async (req, res, next) => {
    try {
      const rows = await records.allDocket(req.db, req.user.tenantId, readFilters(req.query))
      const csv = formatCsv([csvColumns(mod), ...rows.map((r) => rowToCsv(mod, r))])
      await writeAudit(req.db, {
        tenantId: req.user.tenantId,
        clientId: req.user.clientId,
        username: req.user.username,
        action: 'EXPORT',
        module: 'DOCKET',
        newValue: { rows: rows.length, filters: req.query }
      })
      const stamp = new Date().toISOString().slice(0, 10)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition',
        `attachment; filename="docket_${req.user.tenantInitials}_${stamp}.csv"`)
      res.send(csv)
    } catch (err) { next(err) }
  })

router.get('/new', requireAuth, requireTenant,
  requirePermission('docket.write'), async (req, res, next) => {
    try {
      const context = await formContext(req)
      res.render('pages/docket-form', {
        title: 'New docket entry',
        activeNav: 'docket',
        record: null,
        values: {
          ip_type: req.query.ip_type || '',
          ip_record_ref: req.query.ip_record_ref || '',
          priority: 'Medium'
        },
        errors: [],
        ...context
      })
    } catch (err) { next(err) }
  })

router.post('/', requireAuth, requireTenant,
  requirePermission('docket.write'), async (req, res, next) => {
    try {
      const lookups = await records.buildLookups(req.db, req.user.tenantId, 'docket')
      const body = normalizeBody(req.body)
      const { values, errors } = validateRecord(mod, body, lookups)
      const link = await resolveLink(req, values)
      if (link.error) errors.push(link.error)

      if (errors.length > 0) {
        const context = await formContext(req)
        return res.status(400).render('pages/docket-form', {
          title: 'New docket entry',
          activeNav: 'docket',
          record: null,
          values: body,
          errors,
          ...context
        })
      }
      const created = await records.createDocket(req.db, req.user, values)
      req.flash('ok', 'Docket entry created.')
      res.redirect(`/docket/${created.id}`)
    } catch (err) { next(err) }
  })

router.get('/:id', requireAuth, requireTenant, async (req, res, next) => {
  try {
    const record = await records.getDocket(req.db, req.user.tenantId, req.params.id)
    if (!record) {
      return res.status(404).render('pages/error', {
        title: 'Not found', message: 'That docket entry does not exist, or it belongs to another client.'
      })
    }
    const history = res.locals.can('audit.view')
      ? await queryAudit(req.db, req.user.tenantId, { module: 'DOCKET', recordId: record.id }, { limit: 20 })
      : { rows: [] }
    res.render('pages/docket-detail', {
      title: record.title,
      activeNav: 'docket',
      record,
      history: history.rows
    })
  } catch (err) { next(err) }
})

router.get('/:id/edit', requireAuth, requireTenant,
  requirePermission('docket.write'), async (req, res, next) => {
    try {
      const record = await records.getDocket(req.db, req.user.tenantId, req.params.id)
      if (!record) return res.status(404).render('pages/error', { title: 'Not found', message: 'Docket entry not found.' })
      const context = await formContext(req)
      res.render('pages/docket-form', {
        title: 'Edit docket entry',
        activeNav: 'docket',
        record,
        values: record,
        errors: [],
        ...context
      })
    } catch (err) { next(err) }
  })

router.post('/:id', requireAuth, requireTenant,
  requirePermission('docket.write'), async (req, res, next) => {
    try {
      const record = await records.getDocket(req.db, req.user.tenantId, req.params.id)
      if (!record) return res.status(404).render('pages/error', { title: 'Not found', message: 'Docket entry not found.' })

      const lookups = await records.buildLookups(req.db, req.user.tenantId, 'docket')
      const body = normalizeBody(req.body)
      const { values, errors } = validateRecord(mod, body, lookups)
      const link = await resolveLink(req, values)
      if (link.error) errors.push(link.error)

      if (errors.length > 0) {
        const context = await formContext(req)
        return res.status(400).render('pages/docket-form', {
          title: 'Edit docket entry',
          activeNav: 'docket',
          record,
          values: { ...body, id: record.id },
          errors,
          ...context
        })
      }
      await records.updateDocket(req.db, req.user, record.id, values)
      req.flash('ok', 'Docket entry updated.')
      res.redirect(`/docket/${record.id}`)
    } catch (err) { next(err) }
  })

/** Mark completed with a status date and comments (UC-11). */
router.post('/:id/complete', requireAuth, requireTenant,
  requirePermission('docket.write'), async (req, res, next) => {
    try {
      const record = await records.getDocket(req.db, req.user.tenantId, req.params.id)
      if (!record) return res.status(404).render('pages/error', { title: 'Not found', message: 'Docket entry not found.' })
      const comments = String(req.body.comments || '').trim()
      await records.updateDocket(req.db, req.user, record.id, {
        completed: true,
        status: 'Completed',
        status_date: new Date().toISOString().slice(0, 10),
        comments: comments
          ? [record.comments, comments].filter(Boolean).join('\n')
          : record.comments
      })
      req.flash('ok', 'Docket entry marked completed.')
      res.redirect(`/docket/${record.id}`)
    } catch (err) { next(err) }
  })

router.post('/:id/reopen', requireAuth, requireTenant,
  requirePermission('docket.write'), async (req, res, next) => {
    try {
      await records.updateDocket(req.db, req.user, req.params.id, {
        completed: false, status: 'Open', status_date: new Date().toISOString().slice(0, 10)
      })
      req.flash('ok', 'Docket entry reopened.')
      res.redirect(`/docket/${req.params.id}`)
    } catch (err) { next(err) }
  })

router.post('/:id/delete', requireAuth, requireTenant,
  requirePermission('docket.delete'), async (req, res, next) => {
    try {
      await records.deleteDocket(req.db, req.user.tenantId, req.params.id)
      req.flash('ok', 'Docket entry deleted.')
      res.redirect('/docket')
    } catch (err) { next(err) }
  })

module.exports = router
