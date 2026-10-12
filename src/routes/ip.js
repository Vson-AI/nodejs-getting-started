const express = require('express')
const { getModule, csvColumns, AUDIT_MODULE_BY_IP_TYPE } = require('../lib/modules')
const records = require('../lib/records')
const { validateRecord } = require('../lib/validate')
const { formatCsv } = require('../lib/csv')
const { rowToCsv } = require('../lib/importer')
const { writeAudit, queryAudit } = require('../lib/audit')
const { requireAuth, requireTenant, requirePermission } = require('../middleware/context')

const router = express.Router()

/** Resolve :module into a module definition. */
router.param('module', (req, res, next, slug) => {
  const mod = getModule(slug)
  if (!mod) {
    return res.status(404).render('pages/error', {
      title: 'Not found', message: `There is no IP module called "${slug}".`
    })
  }
  req.mod = mod
  res.locals.mod = mod
  next()
})

router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) {
    return res.status(404).render('pages/error', {
      title: 'Not found', message: 'That record reference is not valid.'
    })
  }
  next()
})

/** Multi-value form inputs arrive as arrays; the validator expects ; lists. */
function normalizeBody (mod, body) {
  const out = { ...body }
  for (const field of mod.fields) {
    const value = out[field.name]
    if (Array.isArray(value)) out[field.name] = value.join(';')
  }
  return out
}

function readFilters (query) {
  return {
    search: (query.q || '').trim() || null,
    status: query.status || null,
    clientId: query.client || null,
    filedFrom: query.from || null,
    filedTo: query.to || null,
    expiringDays: query.expiring || null,
    territory: query.territory || null,
    niceClass: query.nice_class || null
  }
}

async function formContext (req, mod) {
  const statuses = await records.getStatuses(req.db, req.user.tenantId, mod.statusKey)
  const countries = await records.getCountries(req.db, req.user.tenantId)
  const clients = await records.getClients(req.db, req.user.tenantId)
  return { statuses, countries, clients }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get('/:module', requireAuth, requireTenant, async (req, res, next) => {
  try {
    const mod = req.mod
    const filters = readFilters(req.query)
    const limit = 25
    const offset = (Math.max(Number(req.query.page) || 1, 1) - 1) * limit
    const list = await records.listRecords(req.db, mod, req.user.tenantId, filters,
      { limit, offset, sort: req.query.sort, dir: req.query.dir })
    const statuses = await records.getStatuses(req.db, req.user.tenantId, mod.statusKey)
    const clients = await records.getClients(req.db, req.user.tenantId)
    res.render('pages/ip-list', {
      title: mod.plural,
      activeNav: mod.slug,
      list,
      statuses,
      clients,
      filters: req.query,
      page: Math.max(Number(req.query.page) || 1, 1)
    })
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------------------
// Export (FR-IMP-021, FR-IMP-022)
// ---------------------------------------------------------------------------
router.get('/:module/export.csv', requireAuth, requireTenant,
  requirePermission('data.export'), async (req, res, next) => {
    try {
      const mod = req.mod
      const rows = await records.allRecords(req.db, mod, req.user.tenantId, readFilters(req.query))
      const csv = formatCsv([csvColumns(mod), ...rows.map((r) => rowToCsv(mod, r))])
      await writeAudit(req.db, {
        tenantId: req.user.tenantId,
        clientId: req.user.clientId,
        username: req.user.username,
        action: 'EXPORT',
        module: mod.slug.toUpperCase(),
        newValue: { rows: rows.length, filters: req.query }
      })
      const stamp = new Date().toISOString().slice(0, 10)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition',
        `attachment; filename="${mod.slug}_${req.user.tenantInitials}_${stamp}.csv"`)
      res.send(csv)
    } catch (err) { next(err) }
  })

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
router.get('/:module/new', requireAuth, requireTenant,
  requirePermission('ip.create'), async (req, res, next) => {
    try {
      const context = await formContext(req, req.mod)
      res.render('pages/ip-form', {
        title: `New ${req.mod.label.toLowerCase()}`,
        activeNav: req.mod.slug,
        record: null,
        values: {},
        errors: [],
        ...context
      })
    } catch (err) { next(err) }
  })

router.post('/:module', requireAuth, requireTenant,
  requirePermission('ip.create'), async (req, res, next) => {
    try {
      const mod = req.mod
      const lookups = await records.buildLookups(req.db, req.user.tenantId, mod.statusKey)
      const body = normalizeBody(mod, req.body)
      const { values, errors } = validateRecord(mod, body, lookups)

      if (errors.length > 0) {
        const context = await formContext(req, mod)
        return res.status(400).render('pages/ip-form', {
          title: `New ${mod.label.toLowerCase()}`,
          activeNav: mod.slug,
          record: null,
          values: body,
          errors,
          ...context
        })
      }

      const created = await req.db.tx((tx) => records.createRecord(tx, mod, req.user, values))
      req.flash('ok', `${mod.label} ${created.three_eyes_ref} created.`)
      res.redirect(`/ip/${mod.slug}/${created.id}`)
    } catch (err) { next(err) }
  })

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
router.get('/:module/:id', requireAuth, requireTenant, async (req, res, next) => {
  try {
    const mod = req.mod
    const record = await records.getRecord(req.db, mod, req.user.tenantId, req.params.id)
    if (!record) {
      return res.status(404).render('pages/error', {
        title: 'Not found', message: 'That record does not exist, or it belongs to another client.'
      })
    }
    const dockets = await records.listDocket(req.db, req.user.tenantId,
      { ipType: mod.ipType, ipRecordId: record.id }, { limit: 50 })
    const history = res.locals.can('audit.view')
      ? await queryAudit(req.db, req.user.tenantId,
        { module: AUDIT_MODULE_BY_IP_TYPE[mod.ipType], recordId: record.id }, { limit: 20 })
      : { rows: [] }
    const countries = await records.getCountries(req.db, req.user.tenantId)
    res.render('pages/ip-detail', {
      title: record.three_eyes_ref,
      activeNav: mod.slug,
      record,
      dockets: dockets.rows,
      history: history.rows,
      countryNames: new Map(countries.map((c) => [c.code, c.name]))
    })
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
router.get('/:module/:id/edit', requireAuth, requireTenant,
  requirePermission('ip.update'), async (req, res, next) => {
    try {
      const mod = req.mod
      const record = await records.getRecord(req.db, mod, req.user.tenantId, req.params.id)
      if (!record) return res.status(404).render('pages/error', { title: 'Not found', message: 'Record not found.' })
      const context = await formContext(req, mod)
      res.render('pages/ip-form', {
        title: `Edit ${record.three_eyes_ref}`,
        activeNav: mod.slug,
        record,
        values: record,
        errors: [],
        ...context
      })
    } catch (err) { next(err) }
  })

router.post('/:module/:id', requireAuth, requireTenant,
  requirePermission('ip.update'), async (req, res, next) => {
    try {
      const mod = req.mod
      const record = await records.getRecord(req.db, mod, req.user.tenantId, req.params.id)
      if (!record) return res.status(404).render('pages/error', { title: 'Not found', message: 'Record not found.' })

      const lookups = await records.buildLookups(req.db, req.user.tenantId, mod.statusKey)
      const body = normalizeBody(mod, req.body)
      const { values, errors } = validateRecord(mod, body, lookups)

      if (!res.locals.can('ip.assign_client')) delete values.client_id

      if (errors.length > 0) {
        const context = await formContext(req, mod)
        return res.status(400).render('pages/ip-form', {
          title: `Edit ${record.three_eyes_ref}`,
          activeNav: mod.slug,
          record,
          values: { ...body, id: record.id, three_eyes_ref: record.three_eyes_ref },
          errors,
          ...context
        })
      }

      await records.updateRecord(req.db, mod, req.user, record.id, values)
      req.flash('ok', `${record.three_eyes_ref} updated.`)
      res.redirect(`/ip/${mod.slug}/${record.id}`)
    } catch (err) { next(err) }
  })

// ---------------------------------------------------------------------------
// Delete (ADMIN only; the sequence number is not reused - BR-08)
// ---------------------------------------------------------------------------
router.post('/:module/:id/delete', requireAuth, requireTenant,
  requirePermission('ip.delete'), async (req, res, next) => {
    try {
      const mod = req.mod
      const record = await records.getRecord(req.db, mod, req.user.tenantId, req.params.id)
      if (!record) return res.status(404).render('pages/error', { title: 'Not found', message: 'Record not found.' })
      await records.deleteRecord(req.db, mod, req.user.tenantId, record.id)
      req.flash('ok', `${record.three_eyes_ref} deleted. Its reference number stays retired.`)
      res.redirect(`/ip/${mod.slug}`)
    } catch (err) { next(err) }
  })

module.exports = router
