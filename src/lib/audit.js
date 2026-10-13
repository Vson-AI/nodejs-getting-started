/**
 * Application level audit entries.
 *
 * Table changes are logged by database triggers (FR-AUD-005). This module
 * records the events that have no row behind them: logins, exports, template
 * downloads, import runs and client portal activity (FR-CP-010, FR-IMP-025).
 */

async function writeAudit (db, entry) {
  const {
    tenantId, clientId = null, username, action, module,
    recordId = null, recordRef = null, oldValue = null, newValue = null
  } = entry
  await db.query(
    `INSERT INTO audit_logs (tenant_id, client_id, username, action, module,
                             record_id, record_ref, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tenantId, clientId, username, action, module, recordId, recordRef,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null
    ]
  )
}

function buildAuditFilter (tenantId, filters = {}) {
  const where = ['a.tenant_id = $1']
  const params = [tenantId]
  const p = (v) => {
    params.push(v)
    return '$' + params.length
  }
  if (filters.module) where.push(`a.module = ${p(filters.module)}`)
  if (filters.action) where.push(`a.action = ${p(filters.action)}`)
  if (filters.recordId) where.push(`a.record_id = ${p(Number(filters.recordId))}`)
  if (filters.username) where.push(`a.username ILIKE ${p('%' + filters.username + '%')}`)
  if (filters.clientId) where.push(`a.client_id = ${p(Number(filters.clientId))}`)
  if (filters.from) where.push(`a.created_at >= ${p(filters.from)}`)
  if (filters.to) where.push(`a.created_at < (${p(filters.to)}::date + 1)`)
  return { where: where.join(' AND '), params }
}

async function queryAudit (db, tenantId, filters = {}, page = {}) {
  const source = filters.archived ? 'audit_logs_archive' : 'audit_logs'
  const { where, params } = buildAuditFilter(tenantId, filters)
  const limit = Math.min(Number(page.limit) || 50, 500)
  const offset = Math.max(Number(page.offset) || 0, 0)
  const rows = await db.all(
    `SELECT a.*, c.name AS client_name
       FROM ${source} a
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  )
  const total = Number(
    await db.value(`SELECT count(*) FROM ${source} a WHERE ${where}`, params)
  )
  return { rows, total, limit, offset }
}

/** Fields that actually changed between two audit snapshots. */
function diffValues (oldValue, newValue) {
  const skip = new Set(['updated_at', 'created_at', 'updated_by'])
  const keys = new Set([
    ...Object.keys(oldValue || {}),
    ...Object.keys(newValue || {})
  ])
  const changes = []
  for (const key of keys) {
    if (skip.has(key)) continue
    const before = oldValue ? oldValue[key] : undefined
    const after = newValue ? newValue[key] : undefined
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ key, before, after })
    }
  }
  return changes.sort((a, b) => a.key.localeCompare(b.key))
}

module.exports = { writeAudit, queryAudit, diffValues }
