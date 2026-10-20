const express = require('express')
const reports = require('../lib/reports')
const { IP_MODULES } = require('../lib/modules')
const { requireAuth } = require('../middleware/context')

const router = express.Router()

router.get('/', requireAuth, async (req, res, next) => {
  try {
    if (!req.user.tenantId) return res.redirect('/platform')

    const settings = await req.db.one(
      'SELECT docket_lookahead_days, expiry_lookahead_days FROM tenant_settings WHERE tenant_id = $1',
      [req.user.tenantId]
    )
    const lookaheadDays = settings ? settings.docket_lookahead_days : 30
    const expiryDays = settings ? settings.expiry_lookahead_days : 90

    const summary = await reports.dashboard(req.db, req.user.tenantId, { expiryDays, lookaheadDays })
    const expiring = (await reports.expiringIp(req.db, req.user.tenantId, expiryDays)).slice(0, 8)
    const upcoming = (await reports.docketReport(req.db, req.user.tenantId, { days: lookaheadDays })).slice(0, 8)
    const overdue = (await reports.docketReport(req.db, req.user.tenantId, { overdue: true })).slice(0, 8)

    res.render('pages/dashboard', {
      title: 'Dashboard',
      activeNav: 'dashboard',
      modules: Object.values(IP_MODULES),
      summary,
      expiring,
      upcoming,
      overdue
    })
  } catch (err) { next(err) }
})

router.get('/health', async (req, res) => {
  try {
    await req.db.value('SELECT 1')
    res.json({ status: 'ok' })
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err.message })
  }
})

module.exports = router
