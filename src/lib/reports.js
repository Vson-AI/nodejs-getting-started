const { IP_MODULES } = require('./modules')

/** Reporting and dashboard queries (SRS section 6.9). */

const MODULE_LIST = Object.values(IP_MODULES)

function unionAll (selectFor, extraWhere = '') {
  return MODULE_LIST.map((mod) => selectFor(mod, extraWhere)).join('\nUNION ALL\n')
}

async function dashboard (db, tenantId, { expiryDays = 90, lookaheadDays = 30 } = {}) {
  const counts = {}
  for (const mod of MODULE_LIST) {
    counts[mod.slug] = Number(
      await db.value(`SELECT count(*) FROM ${mod.table} WHERE tenant_id = $1`, [tenantId])
    )
  }

  const docket = await db.one(
    `SELECT
       count(*) FILTER (WHERE completed = FALSE) AS open_count,
       count(*) FILTER (WHERE completed = FALSE AND due_date < CURRENT_DATE) AS overdue_count,
       count(*) FILTER (WHERE completed = FALSE AND due_date BETWEEN CURRENT_DATE
             AND CURRENT_DATE + $2::int) AS upcoming_count
     FROM docket_entries WHERE tenant_id = $1`,
    [tenantId, lookaheadDays]
  )

  const expiringSql = unionAll((mod) =>
    `SELECT count(*) AS n FROM ${mod.table}
      WHERE tenant_id = $1 AND expiry_date IS NOT NULL
        AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::int`)
  const expiring = Number(
    await db.value(`SELECT sum(n) FROM (${expiringSql}) s`, [tenantId, expiryDays])
  )

  return {
    counts,
    totalIp: Object.values(counts).reduce((a, b) => a + b, 0),
    openDocket: Number(docket.open_count),
    overdueDocket: Number(docket.overdue_count),
    upcomingDocket: Number(docket.upcoming_count),
    expiring: expiring || 0,
    expiryDays,
    lookaheadDays
  }
}

/** Portfolio summary: counts per IP type broken down by status (FR-REP-002). */
async function portfolioSummary (db, tenantId, clientId = null) {
  const out = []
  for (const mod of MODULE_LIST) {
    const rows = await db.all(
      `SELECT status, count(*)::int AS n FROM ${mod.table}
        WHERE tenant_id = $1 AND ($2::bigint IS NULL OR client_id = $2)
        GROUP BY status ORDER BY status`,
      [tenantId, clientId]
    )
    out.push({
      module: mod,
      total: rows.reduce((a, r) => a + r.n, 0),
      byStatus: rows
    })
  }
  return out
}

/** Expiring IP across every module (FR-REP-003). */
async function expiringIp (db, tenantId, days = 90, clientId = null) {
  const sql = unionAll((mod) =>
    `SELECT '${mod.label}' AS ip_type, t.three_eyes_ref, t.title, t.status,
            t.expiry_date, c.code AS client_code, c.name AS client_name
       FROM ${mod.table} t LEFT JOIN clients c ON c.id = t.client_id
      WHERE t.tenant_id = $1 AND t.expiry_date IS NOT NULL
        AND t.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::int
        AND ($3::bigint IS NULL OR t.client_id = $3)`)
  return db.all(`${sql} ORDER BY expiry_date`, [tenantId, days, clientId])
}

/** Every IP record of one client, for the client portfolio snapshot (FR-REP-009). */
async function clientPortfolio (db, tenantId, clientId) {
  const sql = unionAll((mod) =>
    `SELECT '${mod.label}' AS ip_type, t.three_eyes_ref, t.title, t.status,
            t.filing_date, t.expiry_date
       FROM ${mod.table} t
      WHERE t.tenant_id = $1 AND t.client_id = $2`)
  return db.all(`${sql} ORDER BY ip_type, three_eyes_ref`, [tenantId, clientId])
}

async function docketReport (db, tenantId, { overdue = false, days = 30, clientId = null } = {}) {
  const params = [tenantId, clientId]
  let condition = 'd.due_date < CURRENT_DATE'
  if (!overdue) {
    params.push(days)
    condition = 'd.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $3::int'
  }
  return db.all(
    `SELECT d.*, c.code AS client_code, c.name AS client_name,
            (CURRENT_DATE - d.due_date) AS days_overdue
       FROM docket_entries d LEFT JOIN clients c ON c.id = d.client_id
      WHERE d.tenant_id = $1 AND d.completed = FALSE AND ${condition}
        AND ($2::bigint IS NULL OR d.client_id = $2)
      ORDER BY d.due_date`,
    params
  )
}

/** Counts per client, used by the Clients grid and the snapshot picker. */
async function clientTotals (db, tenantId) {
  const sql = unionAll((mod) =>
    `SELECT client_id FROM ${mod.table} WHERE tenant_id = $1 AND client_id IS NOT NULL`)
  const rows = await db.all(
    `SELECT client_id, count(*)::int AS n FROM (${sql}) s GROUP BY client_id`,
    [tenantId]
  )
  return new Map(rows.map((r) => [String(r.client_id), r.n]))
}

module.exports = {
  dashboard,
  portfolioSummary,
  expiringIp,
  clientPortfolio,
  docketReport,
  clientTotals
}
