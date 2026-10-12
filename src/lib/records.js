const { IP_MODULES, STATUS_LISTS, IP_TYPE_TO_SLUG } = require('./modules')

/**
 * Data access for the five IP modules and the docket.
 * Every statement is tenant filtered in SQL in addition to the row-level
 * security policy, so a mistake in one layer is still caught by the other
 * (NFR-006, defence in depth).
 */

async function getStatuses (db, tenantId, statusKey) {
  const rows = await db.all(
    `SELECT value FROM status_options
      WHERE ip_type = $1 AND (tenant_id IS NULL OR tenant_id = $2)
      ORDER BY sort_order, value`,
    [statusKey, tenantId]
  )
  if (rows.length === 0) return STATUS_LISTS[statusKey] || []
  return rows.map((r) => r.value)
}

async function getCountries (db, tenantId) {
  return db.all(
    `SELECT code, name FROM countries
      WHERE is_active AND (tenant_id IS NULL OR tenant_id = $1)
      ORDER BY name`,
    [tenantId]
  )
}

async function getClients (db, tenantId, { includeInactive = false } = {}) {
  return db.all(
    `SELECT id, code, name, status FROM clients
      WHERE tenant_id = $1 AND status <> 'DELETED'
        AND ($2 OR status = 'ACTIVE')
      ORDER BY name`,
    [tenantId, includeInactive]
  )
}

/** Everything the validator needs to resolve codes and names. */
async function buildLookups (db, tenantId, statusKey) {
  // Sequential: one database session serves the whole request.
  const statuses = statusKey ? await getStatuses(db, tenantId, statusKey) : []
  const countries = await getCountries(db, tenantId)
  const clients = await getClients(db, tenantId, { includeInactive: true })
  const users = await db.all(
    'SELECT username FROM users WHERE tenant_id = $1 AND status = $2', [tenantId, 'ACTIVE'])
  return {
    statuses,
    countryByCode: new Map(countries.map((c) => [c.code.toUpperCase(), c])),
    countryByName: new Map(countries.map((c) => [c.name.toLowerCase(), c])),
    clientCodes: new Map(clients.map((c) => [c.code.toUpperCase(), c])),
    clientsById: new Map(clients.map((c) => [String(c.id), c])),
    usernames: new Set(users.map((u) => u.username.toLowerCase()))
  }
}

function fieldNames (mod) {
  return mod.fields.map((x) => x.name)
}

/** Build the WHERE clause shared by the grid, the exports and the reports. */
function buildFilter (mod, tenantId, filters = {}) {
  const where = ['t.tenant_id = $1']
  const params = [tenantId]
  const p = (value) => {
    params.push(value)
    return '$' + params.length
  }

  if (filters.search) {
    const cols = (mod.searchFields || ['title']).map((c) => `COALESCE(t.${c}::text, '')`)
    where.push(`(${cols.map((c) => `${c} ILIKE ${p('%' + filters.search + '%')}`).join(' OR ')})`)
  }
  if (filters.status) where.push(`t.status = ${p(filters.status)}`)
  if (filters.clientId) where.push(`t.client_id = ${p(Number(filters.clientId))}`)
  if (filters.unassigned) where.push('t.client_id IS NULL')
  if (filters.filedFrom) where.push(`t.filing_date >= ${p(filters.filedFrom)}`)
  if (filters.filedTo) where.push(`t.filing_date <= ${p(filters.filedTo)}`)
  if (filters.expiringDays) {
    where.push(`t.expiry_date IS NOT NULL AND t.expiry_date BETWEEN CURRENT_DATE
                AND CURRENT_DATE + ${p(Number(filters.expiringDays))}::int`)
  }
  if (filters.territory) where.push(`t.territory ILIKE ${p('%' + filters.territory + '%')}`)
  if (filters.niceClass) where.push(`${p(Number(filters.niceClass))}::int = ANY(t.classes)`)
  return { where: where.join(' AND '), params }
}

const SORTABLE = new Set([
  'three_eyes_ref', 'title', 'status', 'filing_date', 'expiry_date',
  'created_at', 'owner', 'applicant', 'due_date', 'priority'
])

async function listRecords (db, mod, tenantId, filters = {}, page = {}) {
  const { where, params } = buildFilter(mod, tenantId, filters)
  const limit = Math.min(Number(page.limit) || 25, 200)
  const offset = Math.max(Number(page.offset) || 0, 0)
  const sortCol = SORTABLE.has(page.sort) ? page.sort : 'created_at'
  const sortDir = page.dir === 'asc' ? 'ASC' : 'DESC'

  const rows = await db.all(
    `SELECT t.*, c.name AS client_name, c.code AS client_code
       FROM ${mod.table} t
       LEFT JOIN clients c ON c.id = t.client_id
      WHERE ${where}
      ORDER BY t.${sortCol} ${sortDir} NULLS LAST, t.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  )
  const total = Number(
    await db.value(`SELECT count(*) FROM ${mod.table} t WHERE ${where}`, params)
  )
  return { rows, total, limit, offset }
}

/** Unpaged stream of rows for exports (FR-IMP-021). */
async function allRecords (db, mod, tenantId, filters = {}) {
  const { where, params } = buildFilter(mod, tenantId, filters)
  return db.all(
    `SELECT t.*, c.code AS client_code
       FROM ${mod.table} t
       LEFT JOIN clients c ON c.id = t.client_id
      WHERE ${where}
      ORDER BY t.three_eyes_ref`,
    params
  )
}

async function getRecord (db, mod, tenantId, id) {
  return db.one(
    `SELECT t.*, c.name AS client_name, c.code AS client_code
       FROM ${mod.table} t
       LEFT JOIN clients c ON c.id = t.client_id
      WHERE t.tenant_id = $1 AND t.id = $2`,
    [tenantId, Number(id)]
  )
}

async function getRecordByRef (db, mod, tenantId, ref) {
  return db.one(
    `SELECT * FROM ${mod.table} WHERE tenant_id = $1 AND three_eyes_ref = $2`,
    [tenantId, ref]
  )
}

/** Resolve a docket link: ip_type + three_eyes_ref -> record. */
async function findIpByRef (db, tenantId, ipType, ref) {
  const slug = IP_TYPE_TO_SLUG[ipType]
  const mod = IP_MODULES[slug]
  if (!mod) return null
  return db.one(
    `SELECT id, client_id, three_eyes_ref FROM ${mod.table}
      WHERE tenant_id = $1 AND three_eyes_ref = $2`,
    [tenantId, ref]
  )
}

/**
 * Create an IP record. Must run inside a transaction so the reference
 * counter lock is held until commit (R-05, UC-21).
 */
async function createRecord (db, mod, user, values) {
  const year = values.filing_date
    ? Number(String(values.filing_date).slice(0, 4))
    : new Date().getUTCFullYear()

  const ref = await db.value('SELECT app_next_reference($1, $2, $3)', [
    user.tenantId, mod.typeCode, year
  ])

  const cols = ['tenant_id', 'client_id', 'three_eyes_ref', ...fieldNames(mod), 'created_by', 'updated_by']
  const vals = [
    user.tenantId,
    values.client_id ?? null,
    ref,
    ...fieldNames(mod).map((n) => (values[n] === undefined ? null : values[n])),
    user.username,
    user.username
  ]
  const placeholders = vals.map((_, i) => '$' + (i + 1)).join(', ')
  return db.one(
    `INSERT INTO ${mod.table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals
  )
}

async function updateRecord (db, mod, user, id, values) {
  const names = fieldNames(mod).filter((n) => values[n] !== undefined)
  const sets = []
  const params = []
  const p = (v) => {
    params.push(v)
    return '$' + params.length
  }
  for (const name of names) sets.push(`${name} = ${p(values[name])}`)
  if (values.client_id !== undefined) sets.push(`client_id = ${p(values.client_id)}`)
  sets.push(`updated_by = ${p(user.username)}`)

  const idParam = p(Number(id))
  const tenantParam = p(user.tenantId)
  return db.one(
    `UPDATE ${mod.table} SET ${sets.join(', ')}
      WHERE id = ${idParam} AND tenant_id = ${tenantParam} RETURNING *`,
    params
  )
}

async function deleteRecord (db, mod, tenantId, id) {
  const { rowCount } = await db.query(
    `DELETE FROM ${mod.table} WHERE id = $1 AND tenant_id = $2`,
    [Number(id), tenantId]
  )
  return rowCount > 0
}

// ---------------------------------------------------------------------------
// Docket
// ---------------------------------------------------------------------------
const DOCKET_FIELDS = [
  'ip_type', 'ip_record_id', 'ip_record_ref', 'title', 'description', 'due_date',
  'assigned_to', 'status', 'status_date', 'action_due', 'action_due_date',
  'priority', 'comments', 'documents', 'reproduction', 'certificate'
]

function buildDocketFilter (tenantId, filters = {}) {
  const where = ['d.tenant_id = $1']
  const params = [tenantId]
  const p = (value) => {
    params.push(value)
    return '$' + params.length
  }
  if (filters.search) {
    where.push(`(COALESCE(d.title,'') ILIKE ${p('%' + filters.search + '%')}
                 OR COALESCE(d.ip_record_ref,'') ILIKE ${p('%' + filters.search + '%')}
                 OR COALESCE(d.assigned_to,'') ILIKE ${p('%' + filters.search + '%')})`)
  }
  if (filters.ipType) where.push(`d.ip_type = ${p(filters.ipType)}`)
  if (filters.ipRecordId) where.push(`d.ip_record_id = ${p(Number(filters.ipRecordId))}`)
  if (filters.status) where.push(`d.status = ${p(filters.status)}`)
  if (filters.priority) where.push(`d.priority = ${p(filters.priority)}`)
  if (filters.assignedTo) where.push(`d.assigned_to = ${p(filters.assignedTo)}`)
  if (filters.clientId) where.push(`d.client_id = ${p(Number(filters.clientId))}`)
  if (filters.completed === 'yes') where.push('d.completed = TRUE')
  if (filters.completed === 'no') where.push('d.completed = FALSE')
  if (filters.dueFrom) where.push(`d.due_date >= ${p(filters.dueFrom)}`)
  if (filters.dueTo) where.push(`d.due_date <= ${p(filters.dueTo)}`)
  if (filters.overdue) where.push('d.completed = FALSE AND d.due_date < CURRENT_DATE')
  if (filters.upcomingDays) {
    where.push(`d.completed = FALSE AND d.due_date BETWEEN CURRENT_DATE
                AND CURRENT_DATE + ${p(Number(filters.upcomingDays))}::int`)
  }
  return { where: where.join(' AND '), params }
}

async function listDocket (db, tenantId, filters = {}, page = {}) {
  const { where, params } = buildDocketFilter(tenantId, filters)
  const limit = Math.min(Number(page.limit) || 25, 500)
  const offset = Math.max(Number(page.offset) || 0, 0)
  const sortCol = SORTABLE.has(page.sort) ? page.sort : 'due_date'
  const sortDir = page.dir === 'desc' ? 'DESC' : 'ASC'
  const rows = await db.all(
    `SELECT d.*, c.name AS client_name, c.code AS client_code
       FROM docket_entries d
       LEFT JOIN clients c ON c.id = d.client_id
      WHERE ${where}
      ORDER BY d.${sortCol} ${sortDir} NULLS LAST, d.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  )
  const total = Number(
    await db.value(`SELECT count(*) FROM docket_entries d WHERE ${where}`, params)
  )
  return { rows, total, limit, offset }
}

async function allDocket (db, tenantId, filters = {}) {
  const { where, params } = buildDocketFilter(tenantId, filters)
  return db.all(
    `SELECT d.*, c.code AS client_code
       FROM docket_entries d
       LEFT JOIN clients c ON c.id = d.client_id
      WHERE ${where} ORDER BY d.due_date`,
    params
  )
}

async function getDocket (db, tenantId, id) {
  return db.one(
    `SELECT d.*, c.name AS client_name, c.code AS client_code
       FROM docket_entries d
       LEFT JOIN clients c ON c.id = d.client_id
      WHERE d.tenant_id = $1 AND d.id = $2`,
    [tenantId, Number(id)]
  )
}

async function createDocket (db, user, values) {
  const cols = ['tenant_id', 'client_id', ...DOCKET_FIELDS, 'created_by', 'updated_by']
  const vals = [
    user.tenantId,
    values.client_id ?? null,
    ...DOCKET_FIELDS.map((n) => (values[n] === undefined ? null : values[n])),
    user.username,
    user.username
  ]
  const placeholders = vals.map((_, i) => '$' + (i + 1)).join(', ')
  return db.one(
    `INSERT INTO docket_entries (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals
  )
}

async function updateDocket (db, user, id, values) {
  const names = DOCKET_FIELDS.filter((n) => values[n] !== undefined)
  const sets = []
  const params = []
  const p = (v) => {
    params.push(v)
    return '$' + params.length
  }
  for (const name of names) sets.push(`${name} = ${p(values[name])}`)
  if (values.client_id !== undefined) sets.push(`client_id = ${p(values.client_id)}`)
  if (values.completed !== undefined) sets.push(`completed = ${p(values.completed)}`)
  sets.push(`updated_by = ${p(user.username)}`)
  const idParam = p(Number(id))
  const tenantParam = p(user.tenantId)
  return db.one(
    `UPDATE docket_entries SET ${sets.join(', ')}
      WHERE id = ${idParam} AND tenant_id = ${tenantParam} RETURNING *`,
    params
  )
}

async function deleteDocket (db, tenantId, id) {
  const { rowCount } = await db.query(
    'DELETE FROM docket_entries WHERE id = $1 AND tenant_id = $2',
    [Number(id), tenantId]
  )
  return rowCount > 0
}

module.exports = {
  getStatuses,
  getCountries,
  getClients,
  buildLookups,
  listRecords,
  allRecords,
  getRecord,
  getRecordByRef,
  findIpByRef,
  createRecord,
  updateRecord,
  deleteRecord,
  listDocket,
  allDocket,
  getDocket,
  createDocket,
  updateDocket,
  deleteDocket,
  DOCKET_FIELDS
}
