const express = require('express')
const reportLib = require('../lib/reports')
const records = require('../lib/records')
const { formatCsv } = require('../lib/csv')
const { writeAudit } = require('../lib/audit')
const { requireAuth, requireTenant, requirePermission } = require('../middleware/context')

const router = express.Router()

router.use(requireAuth, requireTenant, requirePermission('reports.run'))

const REPORTS = {
  portfolio: { title: 'Portfolio summary', requirement: 'FR-REP-002' },
  expiring: { title: 'Expiring IP', requirement: 'FR-REP-003' },
  upcoming: { title: 'Upcoming docket', requirement: 'FR-REP-004' },
  overdue: { title: 'Overdue docket', requirement: 'FR-REP-005' },
  snapshot: { title: 'Client portfolio snapshot', requirement: 'FR-REP-009' }
}

/** Client users are always scoped to their own client (FR-REP-008). */
function scopeClientId (req) {
  if (req.user.userType === 'CLIENT') return req.user.clientId
  return req.query.client ? Number(req.query.client) : null
}

async function buildReport (req, name) {
  const tenantId = req.user.tenantId
  const clientId = scopeClientId(req)
  const days = Math.max(Number(req.query.days) || 0, 0)

  switch (name) {
    case 'portfolio': {
      const summary = await reportLib.portfolioSummary(req.db, tenantId, clientId)
      return {
        columns: ['ip_type', 'status', 'count'],
        rows: summary.flatMap((group) =>
          group.byStatus.map((s) => ({ ip_type: group.module.plural, status: s.status, count: s.n }))),
        groups: summary
      }
    }
    case 'expiring': {
      const rows = await reportLib.expiringIp(req.db, tenantId, days || 90, clientId)
      return { columns: ['ip_type', 'three_eyes_ref', 'title', 'status', 'expiry_date', 'client_code'], rows }
    }
    case 'upcoming': {
      const rows = await reportLib.docketReport(req.db, tenantId, { days: days || 30, clientId })
      return { columns: ['due_date', 'title', 'ip_record_ref', 'assigned_to', 'priority', 'status', 'client_code'], rows }
    }
    case 'overdue': {
      const rows = await reportLib.docketReport(req.db, tenantId, { overdue: true, clientId })
      return { columns: ['due_date', 'days_overdue', 'title', 'ip_record_ref', 'assigned_to', 'priority', 'client_code'], rows }
    }
    case 'snapshot': {
      if (!clientId) return { columns: [], rows: [], needsClient: true }
      const rows = await reportLib.clientPortfolio(req.db, tenantId, clientId)
      return { columns: ['ip_type', 'three_eyes_ref', 'title', 'status', 'filing_date', 'expiry_date'], rows }
    }
    default:
      return null
  }
}

router.get('/', async (req, res, next) => {
  try {
    const clients = req.user.userType === 'CLIENT'
      ? []
      : await records.getClients(req.db, req.user.tenantId, { includeInactive: true })
    res.render('pages/reports', {
      title: 'Reports',
      activeNav: 'reports',
      reports: REPORTS,
      clients
    })
  } catch (err) { next(err) }
})

router.get('/:name', async (req, res, next) => {
  try {
    const name = req.params.name.replace(/\.csv$/, '')
    const meta = REPORTS[name]
    if (!meta) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown report.' })

    const report = await buildReport(req, name)
    const clients = req.user.userType === 'CLIENT'
      ? []
      : await records.getClients(req.db, req.user.tenantId, { includeInactive: true })

    if (req.params.name.endsWith('.csv')) {
      if (!res.locals.can('data.export')) {
        return res.status(403).render('pages/error', {
          title: 'Access denied', message: 'Your role may view reports but not export them.'
        })
      }
      const header = report.columns
      const rows = report.rows.map((row) => header.map((col) => {
        const value = row[col]
        if (value == null) return ''
        if (value instanceof Date) return value.toISOString().slice(0, 10)
        return String(value)
      }))
      await writeAudit(req.db, {
        tenantId: req.user.tenantId,
        clientId: req.user.clientId,
        username: req.user.username,
        action: 'EXPORT',
        module: 'REPORT',
        recordRef: name,
        newValue: { rows: rows.length }
      })
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition',
        `attachment; filename="${name}_${req.user.tenantInitials}_${new Date().toISOString().slice(0, 10)}.csv"`)
      return res.send(formatCsv([header, ...rows]))
    }

    res.render('pages/report-view', {
      title: meta.title,
      activeNav: 'reports',
      name,
      meta,
      report,
      clients,
      filters: req.query
    })
  } catch (err) { next(err) }
})

module.exports = router
