const express = require('express')
const { queryAudit, diffValues, writeAudit } = require('../lib/audit')
const { formatCsv } = require('../lib/csv')
const records = require('../lib/records')
const { requireAuth, requireTenant, requirePermission } = require('../middleware/context')

const router = express.Router()
const MODULES = ['PATENT', 'UTILITY_MODEL', 'TRADEMARK', 'COPYRIGHT', 'DESIGN',
  'DOCKET', 'CLIENT', 'USER', 'SETTINGS', 'TENANT', 'AUTH', 'AUDIT']

router.use(requireAuth, requireTenant, requirePermission('audit.view'))

function readFilters (query) {
  return {
    module: query.module || null,
    action: query.action || null,
    recordId: query.record_id || null,
    username: query.username || null,
    clientId: query.client || null,
    from: query.from || null,
    to: query.to || null,
    archived: query.archived === '1'
  }
}

router.get('/', async (req, res, next) => {
  try {
    const filters = readFilters(req.query)
    const limit = 50
    const offset = (Math.max(Number(req.query.page) || 1, 1) - 1) * limit
    const result = await queryAudit(req.db, req.user.tenantId, filters, { limit, offset })
    const clients = await records.getClients(req.db, req.user.tenantId, { includeInactive: true })
    res.render('pages/audit', {
      title: 'Audit trail',
      activeNav: 'audit',
      result,
      clients,
      modules: MODULES,
      filters: req.query,
      page: Math.max(Number(req.query.page) || 1, 1),
      diffValues
    })
  } catch (err) { next(err) }
})

router.get('/export.csv', requirePermission('audit.export'), async (req, res, next) => {
  try {
    const filters = readFilters(req.query)
    const result = await queryAudit(req.db, req.user.tenantId, filters, { limit: 500, offset: 0 })
    const rows = [['timestamp', 'username', 'action', 'module', 'record_id', 'record_ref', 'client', 'changes']]
    for (const row of result.rows) {
      const changes = diffValues(row.old_value, row.new_value)
        .map((c) => `${c.key}: ${JSON.stringify(c.before) ?? ''} -> ${JSON.stringify(c.after) ?? ''}`)
        .join(' | ')
      rows.push([
        new Date(row.created_at).toISOString(), row.username, row.action, row.module,
        row.record_id || '', row.record_ref || '', row.client_name || '', changes
      ])
    }
    await writeAudit(req.db, {
      tenantId: req.user.tenantId,
      username: req.user.username,
      action: 'EXPORT',
      module: 'AUDIT',
      newValue: { rows: result.rows.length, filters: req.query }
    })
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition',
      `attachment; filename="audit_${req.user.tenantInitials}_${new Date().toISOString().slice(0, 10)}.csv"`)
    res.send(formatCsv(rows))
  } catch (err) { next(err) }
})

module.exports = router
