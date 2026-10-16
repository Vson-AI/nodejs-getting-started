const express = require('express')
const { encrypt } = require('../lib/crypto')
const { validateInitials } = require('../lib/validate')
const { sendTestEmail } = require('../lib/mailer')
const { writeAudit } = require('../lib/audit')
const { IP_MODULES, STATUS_LISTS } = require('../lib/modules')
const { requireAuth, requireTenant, requirePermission } = require('../middleware/context')

const router = express.Router()

router.use(requireAuth, requireTenant, requirePermission('settings.manage'))

async function ipRecordCount (db, tenantId) {
  let total = 0
  for (const mod of Object.values(IP_MODULES)) {
    total += Number(await db.value(`SELECT count(*) FROM ${mod.table} WHERE tenant_id = $1`, [tenantId]))
  }
  return total
}

router.get('/', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId
    const settings = await req.db.one(
      `SELECT smtp_host, smtp_port, smtp_user, smtp_from, smtp_use_tls, smtp_enabled,
              (smtp_password_encrypted IS NOT NULL) AS has_password,
              file_base_dir, file_cloud_prefix, brand_logo_url,
              docket_lookahead_days, expiry_lookahead_days, import_max_rows, import_max_bytes
         FROM tenant_settings WHERE tenant_id = $1`, [tenantId])
    const tenant = await req.db.one('SELECT * FROM tenants WHERE id = $1', [tenantId])
    const countries = await req.db.all(
      'SELECT id, code, name, is_active FROM countries WHERE tenant_id = $1 ORDER BY name', [tenantId])
    const statusRows = await req.db.all(
      'SELECT id, ip_type, value FROM status_options WHERE tenant_id = $1 ORDER BY ip_type, value', [tenantId])
    const records = await ipRecordCount(req.db, tenantId)
    res.render('pages/settings', {
      title: 'Settings',
      activeNav: 'settings',
      settings: settings || {},
      tenant,
      tenantCountries: countries,
      tenantStatuses: statusRows,
      globalStatuses: STATUS_LISTS,
      ipRecordCount: records,
      canRenameInitials: records === 0
    })
  } catch (err) { next(err) }
})

router.post('/smtp', async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId
    const password = String(req.body.smtp_password || '')
    const fields = {
      smtp_host: String(req.body.smtp_host || '').trim() || null,
      smtp_port: req.body.smtp_port ? Number(req.body.smtp_port) : null,
      smtp_user: String(req.body.smtp_user || '').trim() || null,
      smtp_from: String(req.body.smtp_from || '').trim() || null,
      smtp_use_tls: req.body.smtp_use_tls === 'on',
      smtp_enabled: req.body.smtp_enabled === 'on'
    }
    await req.db.query(
      `UPDATE tenant_settings
          SET smtp_host=$2, smtp_port=$3, smtp_user=$4, smtp_from=$5,
              smtp_use_tls=$6, smtp_enabled=$7, updated_at = now()
        WHERE tenant_id = $1`,
      [tenantId, fields.smtp_host, fields.smtp_port, fields.smtp_user,
        fields.smtp_from, fields.smtp_use_tls, fields.smtp_enabled]
    )
    if (password) {
      await req.db.query(
        'UPDATE tenant_settings SET smtp_password_encrypted = $2 WHERE tenant_id = $1',
        [tenantId, encrypt(password)]
      )
    }
    req.flash('ok', 'Mail settings saved. The password is stored encrypted.')
    res.redirect('/settings')
  } catch (err) { next(err) }
})

router.post('/smtp/test', async (req, res, next) => {
  try {
    const to = String(req.body.test_to || '').trim()
    if (!to) {
      req.flash('error', 'Enter an address to send the test to.')
      return res.redirect('/settings')
    }
    await sendTestEmail(req.db, req.user.tenantId, to, req.user.tenantName)
    await writeAudit(req.db, {
      tenantId: req.user.tenantId,
      username: req.user.username,
      action: 'TEST_EMAIL',
      module: 'SETTINGS',
      newValue: { to }
    })
    req.flash('ok', `Test message sent to ${to}.`)
    res.redirect('/settings')
  } catch (err) {
    req.flash('error', `Test message failed: ${err.message}`)
    res.redirect('/settings')
  }
})

router.post('/files', async (req, res, next) => {
  try {
    await req.db.query(
      `UPDATE tenant_settings
          SET file_base_dir = $2, file_cloud_prefix = $3, brand_logo_url = $4,
              docket_lookahead_days = $5, expiry_lookahead_days = $6,
              import_max_rows = $7, import_max_bytes = $8, updated_at = now()
        WHERE tenant_id = $1`,
      [
        req.user.tenantId,
        String(req.body.file_base_dir || '').trim() || null,
        String(req.body.file_cloud_prefix || '').trim() || null,
        String(req.body.brand_logo_url || '').trim() || null,
        Math.max(Number(req.body.docket_lookahead_days) || 30, 1),
        Math.max(Number(req.body.expiry_lookahead_days) || 90, 1),
        Math.min(Math.max(Number(req.body.import_max_rows) || 50000, 1), 1000000),
        Math.min(Math.max(Number(req.body.import_max_bytes) || 20971520, 1024), 268435456)
      ]
    )
    req.flash('ok', 'Preferences saved.')
    res.redirect('/settings')
  } catch (err) { next(err) }
})

/** Rename tenant initials before the first IP record exists (UC-31, BR-18). */
router.post('/initials', requirePermission('tenant.rename_initials'), async (req, res, next) => {
  try {
    const tenantId = req.user.tenantId
    const count = await ipRecordCount(req.db, tenantId)
    if (count > 0) {
      req.flash('error', 'Initials are locked once the first IP record exists (BR-18).')
      return res.redirect('/settings')
    }
    const { value, error } = validateInitials(req.body.initials)
    if (error) {
      req.flash('error', error)
      return res.redirect('/settings')
    }
    const clash = await req.db.one('SELECT id FROM tenants WHERE initials = $1 AND id <> $2', [value, tenantId])
    if (clash) {
      req.flash('error', 'Those initials are already used by another agency.')
      return res.redirect('/settings')
    }
    await req.db.query('UPDATE tenants SET initials = $2 WHERE id = $1', [tenantId, value])
    req.flash('ok', `Initials changed to ${value}. New references will use it.`)
    res.redirect('/settings')
  } catch (err) { next(err) }
})

/** Tenant extensions to the global country list (FR-CFG-007). */
router.post('/countries', async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase()
    const name = String(req.body.name || '').trim()
    if (!/^[A-Z0-9]{2,3}$/.test(code) || name.length < 2) {
      req.flash('error', 'Enter a 2 or 3 character code and a name.')
      return res.redirect('/settings')
    }
    const exists = await req.db.one(
      'SELECT id FROM countries WHERE code = $1 AND (tenant_id IS NULL OR tenant_id = $2)',
      [code, req.user.tenantId])
    if (exists) {
      req.flash('error', `${code} is already in the list.`)
      return res.redirect('/settings')
    }
    await req.db.query(
      'INSERT INTO countries (code, name, tenant_id) VALUES ($1, $2, $3)',
      [code, name, req.user.tenantId])
    req.flash('ok', `${name} added to the country list.`)
    res.redirect('/settings')
  } catch (err) { next(err) }
})

router.post('/countries/:id/delete', async (req, res, next) => {
  try {
    await req.db.query('DELETE FROM countries WHERE id = $1 AND tenant_id = $2',
      [Number(req.params.id), req.user.tenantId])
    req.flash('ok', 'Country removed from your extensions.')
    res.redirect('/settings')
  } catch (err) { next(err) }
})

/** Tenant extensions to the controlled status lists (BR-12). */
router.post('/statuses', async (req, res, next) => {
  try {
    const ipType = String(req.body.ip_type || '')
    const value = String(req.body.value || '').trim()
    if (!STATUS_LISTS[ipType] || value.length < 2) {
      req.flash('error', 'Choose an IP type and enter a status name.')
      return res.redirect('/settings')
    }
    const globals = STATUS_LISTS[ipType].map((s) => s.toLowerCase())
    if (globals.includes(value.toLowerCase())) {
      req.flash('error', `${value} is already a standard status for that type.`)
      return res.redirect('/settings')
    }
    await req.db.query(
      `INSERT INTO status_options (tenant_id, ip_type, value, sort_order)
       VALUES ($1, $2, $3, 500) ON CONFLICT DO NOTHING`,
      [req.user.tenantId, ipType, value])
    // A tenant list replaces the global list, so seed the standard values too.
    for (const [i, standard] of STATUS_LISTS[ipType].entries()) {
      await req.db.query(
        `INSERT INTO status_options (tenant_id, ip_type, value, sort_order)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [req.user.tenantId, ipType, standard, i * 10])
    }
    req.flash('ok', `${value} added to the ${ipType} status list.`)
    res.redirect('/settings')
  } catch (err) { next(err) }
})

router.post('/statuses/:id/delete', async (req, res, next) => {
  try {
    await req.db.query('DELETE FROM status_options WHERE id = $1 AND tenant_id = $2',
      [Number(req.params.id), req.user.tenantId])
    req.flash('ok', 'Status removed.')
    res.redirect('/settings')
  } catch (err) { next(err) }
})

module.exports = router
