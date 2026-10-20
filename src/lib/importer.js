const fs = require('fs')
const { CsvStreamParser, formatCsv } = require('./csv')
const { getImportModule, csvColumns, csvDescriptions, sampleRow, IP_MODULES } = require('./modules')
const { validateRecord } = require('./validate')
const records = require('./records')
const { writeAudit } = require('./audit')
const { withContext } = require('../db/pool')
const { sha256 } = require('./crypto')

/**
 * Bulk CSV import (SRS section 6.13, use cases 33 to 38).
 *
 * Dry run never writes to a destination table (BR-32). Commit either runs as
 * a single transaction ("abort on error") or in batches of BATCH_SIZE when
 * "skip invalid rows" is chosen (BR-38, NFR-024). Rows created by an import
 * go through the same insert path as typed rows, so reference generation and
 * the audit triggers behave identically (BR-33, BR-39).
 */

const BATCH_SIZE = 500
const cancelled = new Set()

function requestCancel (jobId) {
  cancelled.add(Number(jobId))
}

function isCancelled (jobId) {
  return cancelled.has(Number(jobId))
}

// ---------------------------------------------------------------------------
// Templates (FR-IMP-001 .. 003)
// ---------------------------------------------------------------------------
function templateCsv (mod, variant, rows = []) {
  const header = csvColumns(mod)
  const out = [header]
  if (variant === 'described' || variant === 'sample') {
    out.push(csvDescriptions(mod))
  }
  if (variant === 'sample') {
    out.push(sampleRow(mod))
  }
  for (const row of rows) out.push(row)
  return formatCsv(out)
}

/** Serialise stored rows back into template column order (FR-IMP-022). */
function rowToCsv (mod, row) {
  return csvColumns(mod).map((col) => {
    if (col === 'action') return 'UPDATE'
    if (col === 'existing_reference') {
      return mod.slug === 'docket' ? String(row.id) : row.three_eyes_ref
    }
    if (col === 'client_code') return row.client_code || ''
    if (col === 'created_by') return row.created_by || ''
    const value = row[col]
    if (value == null) return ''
    if (Array.isArray(value)) return value.join(';')
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return String(value)
  })
}

function templateFileName (mod, initials) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `${mod.slug}_template_${initials}_${stamp}.csv`
}

// ---------------------------------------------------------------------------
// Row reading
// ---------------------------------------------------------------------------
async function streamRows (filePath, handler) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  let queue = []
  const parser = new CsvStreamParser((cells, rowNumber) => queue.push({ cells, rowNumber }))
  for await (const chunk of stream) {
    parser.push(chunk)
    for (const item of queue) {
      const stop = await handler(item)
      if (stop === false) {
        stream.destroy()
        return
      }
    }
    queue = []
  }
  parser.end()
  for (const item of queue) {
    const stop = await handler(item)
    if (stop === false) return
  }
}

function looksLikeDescriptionRow (mod, raw) {
  const action = String(raw.action || '').trim().toUpperCase()
  return action !== 'CREATE' && action !== 'UPDATE' &&
    /create or update/i.test(String(raw.action || ''))
}

// ---------------------------------------------------------------------------
// Import engine
// ---------------------------------------------------------------------------
async function loadExisting (db, mod, tenantId) {
  const refToId = new Map()
  const regNumbers = new Set()
  if (mod.slug === 'docket') {
    const rows = await db.all('SELECT id FROM docket_entries WHERE tenant_id = $1', [tenantId])
    for (const row of rows) refToId.set(String(row.id), row.id)
    return { refToId, regNumbers }
  }
  const hasRegNo = mod.fields.some((x) => x.name === 'registration_number')
  const rows = await db.all(
    `SELECT id, three_eyes_ref${hasRegNo ? ', registration_number' : ''}
       FROM ${mod.table} WHERE tenant_id = $1`,
    [tenantId]
  )
  for (const row of rows) {
    refToId.set(row.three_eyes_ref, row.id)
    if (hasRegNo && row.registration_number) {
      regNumbers.add(String(row.registration_number).toUpperCase())
    }
  }
  return { refToId, regNumbers }
}

function buildRowContext (header, cells) {
  const raw = {}
  header.forEach((col, i) => {
    raw[col] = cells[i] == null ? '' : cells[i]
  })
  return raw
}

/**
 * Validate one row. Returns { action, values, errors, ref }.
 */
function validateRow (mod, raw, lookups, state) {
  const errors = []
  const action = String(raw.action || '').trim().toUpperCase()
  if (action !== 'CREATE' && action !== 'UPDATE') {
    errors.push({ column: 'action', message: 'action must be CREATE or UPDATE' })
  }

  const ref = String(raw.existing_reference || '').trim()
  if (action === 'UPDATE') {
    if (ref === '') {
      errors.push({ column: 'existing_reference', message: 'existing_reference is required when action=UPDATE' })
    } else if (!state.refToId.has(ref)) {
      errors.push({ column: 'existing_reference', message: `No ${mod.label} with reference "${ref}" in this tenant` })
    } else if (state.seenRefs.has(ref)) {
      errors.push({ column: 'existing_reference', message: `Reference "${ref}" appears more than once in this file` })
    } else {
      state.seenRefs.add(ref)
    }
  } else if (action === 'CREATE' && ref !== '') {
    errors.push({ column: 'existing_reference', message: 'existing_reference must be empty when action=CREATE' })
  }

  const { values, errors: fieldErrors } = validateRecord(mod, raw, lookups)
  errors.push(...fieldErrors)

  // Docket rows must point at an IP record that exists in this tenant
  if (mod.slug === 'docket' && values.ip_type && values.ip_record_ref) {
    if (!state.ipLinks.has(`${values.ip_type}|${values.ip_record_ref}`)) {
      errors.push({
        column: 'ip_record_ref',
        message: `No ${values.ip_type} with reference "${values.ip_record_ref}" in this tenant`
      })
    }
  }

  // Trademark registration numbers are unique per tenant (FR-TM-005)
  const regNo = String(raw.registration_number || '').trim().toUpperCase()
  if (regNo && mod.slug === 'trademarks') {
    const ownedByThisRow = action === 'UPDATE' && ref !== ''
    if (state.fileRegNumbers.has(regNo)) {
      errors.push({ column: 'registration_number', message: `Registration number "${regNo}" appears more than once in this file` })
    } else if (state.regNumbers.has(regNo) && !ownedByThisRow) {
      errors.push({ column: 'registration_number', message: `Registration number "${regNo}" already exists in this tenant` })
    }
    state.fileRegNumbers.add(regNo)
  }

  return { action, ref, values, errors }
}

async function applyRow (db, mod, user, row, state) {
  if (mod.slug === 'docket') return applyDocketRow(db, user, row, state)

  if (row.action === 'CREATE') {
    const created = await records.createRecord(db, mod, user, row.values)
    state.refToId.set(created.three_eyes_ref, created.id)
    if (created.registration_number) {
      state.regNumbers.add(String(created.registration_number).toUpperCase())
    }
    return { operation: 'INSERT', id: created.id, ref: created.three_eyes_ref }
  }
  const id = state.refToId.get(row.ref)
  const updated = await records.updateRecord(db, mod, user, id, row.values)
  return { operation: 'UPDATE', id: updated.id, ref: updated.three_eyes_ref }
}

async function applyDocketRow (db, user, row, state) {
  const values = { ...row.values }
  if (values.ip_type && values.ip_record_ref) {
    const linked = state.ipLinks.get(`${values.ip_type}|${values.ip_record_ref}`)
    if (linked) {
      values.ip_record_id = linked.id
      if (values.client_id == null) values.client_id = linked.client_id // FR-DOC-008
    }
  }
  if (row.action === 'CREATE') {
    const created = await records.createDocket(db, user, values)
    state.refToId.set(String(created.id), created.id)
    return { operation: 'INSERT', id: created.id, ref: String(created.id) }
  }
  const id = state.refToId.get(row.ref)
  const updated = await records.updateDocket(db, user, id, values)
  return { operation: 'UPDATE', id: updated.id, ref: String(updated.id) }
}

/** Every IP reference in the tenant, so docket links resolve without a query per row. */
async function loadIpLinks (db, tenantId) {
  const map = new Map()
  for (const mod of Object.values(IP_MODULES)) {
    const rows = await db.all(
      `SELECT id, client_id, three_eyes_ref FROM ${mod.table} WHERE tenant_id = $1`,
      [tenantId]
    )
    for (const row of rows) map.set(`${mod.ipType}|${row.three_eyes_ref}`, row)
  }
  return map
}

async function recordErrors (db, jobId, errors) {
  if (errors.length === 0) return
  const values = []
  const params = []
  errors.forEach((e, i) => {
    const base = i * 5
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`)
    params.push(jobId, e.rowNumber, e.column || null, String(e.message).slice(0, 500), e.rawRow || null)
  })
  await db.query(
    `INSERT INTO import_job_errors (import_job_id, row_number, column_name, error_message, raw_row)
     VALUES ${values.join(', ')}`,
    params
  )
}

/**
 * Run an import job to completion. Called without await by the route so the
 * browser can poll progress and cancel (FR-IMP-020).
 */
async function runJob (jobId, sessionContext) {
  try {
    await withContext(sessionContext, async (db) => {
      await execute(db, jobId, sessionContext)
    })
  } catch (err) {
    console.error('[import] job %s failed', jobId, err)
    await withContext(sessionContext, async (db) => {
      await db.query(
        `UPDATE import_jobs SET status = 'FAILED', message = $2, finished_at = now()
          WHERE id = $1`,
        [jobId, String(err.message).slice(0, 500)]
      )
    }).catch(() => {})
  } finally {
    cancelled.delete(Number(jobId))
  }
}

async function execute (db, jobId, sessionContext) {
  const job = await db.one('SELECT * FROM import_jobs WHERE id = $1', [jobId])
  if (!job) throw new Error('Import job not found')

  const mod = getImportModule(job.module)
  if (!mod) throw new Error(`Unknown import module ${job.module}`)

  const tenantId = Number(job.tenant_id)
  const user = {
    tenantId,
    username: job.username,
    userId: Number(job.user_id)
  }
  const settings = await db.one(
    'SELECT import_max_rows FROM tenant_settings WHERE tenant_id = $1', [tenantId]
  )
  const maxRows = settings ? settings.import_max_rows : 50000

  const lookups = await records.buildLookups(db, tenantId, mod.statusKey)
  const existing = await loadExisting(db, mod, tenantId)

  const state = {
    refToId: existing.refToId,
    regNumbers: existing.regNumbers,
    seenRefs: new Set(),
    fileRegNumbers: new Set(),
    ipLinks: mod.slug === 'docket' ? await loadIpLinks(db, tenantId) : new Map()
  }

  // Rows already committed by an earlier run of the identical file (FR-IMP-018)
  const previousHashes = new Set()
  if (job.mode === 'COMMIT' && job.file_hash) {
    const rows = await db.all(
      `SELECT r.row_hash FROM import_job_rows r
         JOIN import_jobs j ON j.id = r.import_job_id
        WHERE r.tenant_id = $1 AND r.module = $2 AND j.file_hash = $3 AND j.id <> $4`,
      [tenantId, job.module, job.file_hash, jobId]
    )
    for (const row of rows) previousHashes.add(row.row_hash)
  }

  const header = []
  const parsed = []           // validated rows awaiting commit
  const errors = []
  const counts = { total: 0, inserted: 0, updated: 0, skipped: 0, failed: 0 }
  let headerError = null
  let aborted = false

  const required = csvColumns(mod)

  // Pass 1: read and validate every row. No writes (BR-32).
  await streamRows(job.file_path, async ({ cells, rowNumber }) => {
    if (isCancelled(jobId)) {
      aborted = true
      return false
    }
    if (rowNumber === 1) {
      const incoming = cells.map((c) => c.trim().toLowerCase())
      header.push(...incoming)
      const missing = required.filter(
        (c) => !incoming.includes(c) && c !== 'created_by' && c !== 'client_code'
      )
      if (missing.length > 0) {
        headerError = `The file is missing these columns: ${missing.join(', ')}`
        return false
      }
      return true
    }

    const raw = buildRowContext(header, cells)
    if (rowNumber === 2 && looksLikeDescriptionRow(mod, raw)) return true // template hint row

    counts.total += 1
    if (counts.total > maxRows) {
      headerError = `The file has more than the ${maxRows} rows allowed (BR-40)`
      return false
    }

    const rowHash = sha256(`${tenantId}|${mod.slug}|${JSON.stringify(cells)}`)
    if (previousHashes.has(rowHash)) {
      counts.skipped += 1
      return true
    }

    const result = validateRow(mod, raw, lookups, state)
    if (result.errors.length > 0) {
      counts.failed += 1
      for (const e of result.errors) {
        errors.push({
          rowNumber,
          column: e.column,
          message: e.message,
          rawRow: cells.join(',').slice(0, 4000)
        })
      }
      return true
    }
    parsed.push({ ...result, rowNumber, rowHash })
    return true
  })

  if (aborted) {
    await finishJob(db, jobId, 'CANCELLED', counts, 'Cancelled by an administrator')
    return
  }
  if (headerError) {
    await recordErrors(db, jobId, [{ rowNumber: 1, column: null, message: headerError }])
    await finishJob(db, jobId, 'FAILED', counts, headerError)
    return
  }

  await recordErrors(db, jobId, errors)

  if (job.mode === 'DRY_RUN') {
    await finishJob(db, jobId, 'COMPLETED', counts,
      counts.failed === 0
        ? 'Validation passed. No data was written.'
        : `${counts.failed} row(s) failed validation. No data was written.`)
    return
  }

  // Abort-on-error commits nothing when anything failed validation (FR-IMP-006)
  if (!job.skip_invalid && counts.failed > 0) {
    await finishJob(db, jobId, 'FAILED', counts,
      `${counts.failed} row(s) failed validation, so nothing was imported. ` +
      'Fix the file or re-run with "skip invalid rows".')
    return
  }

  const committedRows = []

  const commitBatch = async (batch) => {
    await db.tx(async (tx) => {
      for (const row of batch) {
        const applied = await applyRow(tx, mod, user, row, state)
        if (applied.operation === 'INSERT') counts.inserted += 1
        else counts.updated += 1
        committedRows.push({ ...applied, rowNumber: row.rowNumber, rowHash: row.rowHash })
      }
    })
  }

  if (job.skip_invalid) {
    for (let i = 0; i < parsed.length; i += BATCH_SIZE) {
      if (isCancelled(jobId)) {
        await finishJob(db, jobId, 'CANCELLED', counts,
          `Cancelled after ${counts.inserted + counts.updated} row(s) were committed.`)
        await saveCommittedRows(db, jobId, tenantId, mod.slug, committedRows)
        return
      }
      await commitBatch(parsed.slice(i, i + BATCH_SIZE))
      await db.query(
        `UPDATE import_jobs SET rows_total = $2, rows_inserted = $3, rows_updated = $4,
                rows_skipped = $5, rows_failed = $6 WHERE id = $1`,
        [jobId, counts.total, counts.inserted, counts.updated, counts.skipped, counts.failed]
      )
    }
  } else {
    await db.tx(async (tx) => {
      for (const row of parsed) {
        const applied = await applyRow(tx, mod, user, row, state)
        if (applied.operation === 'INSERT') counts.inserted += 1
        else counts.updated += 1
        committedRows.push({ ...applied, rowNumber: row.rowNumber, rowHash: row.rowHash })
      }
    })
  }

  await saveCommittedRows(db, jobId, tenantId, mod.slug, committedRows)
  await finishJob(db, jobId, 'COMPLETED', counts,
    `${counts.inserted} created, ${counts.updated} updated, ${counts.skipped} skipped, ${counts.failed} failed.`)

  await writeAudit(db, {
    tenantId,
    username: user.username,
    action: 'IMPORT',
    module: mod.slug.toUpperCase(),
    recordId: jobId,
    newValue: {
      file_name: job.file_name,
      file_hash: job.file_hash,
      rows_total: counts.total,
      rows_inserted: counts.inserted,
      rows_updated: counts.updated,
      rows_skipped: counts.skipped,
      rows_failed: counts.failed
    }
  })
}

async function saveCommittedRows (db, jobId, tenantId, moduleSlug, rows) {
  if (rows.length === 0) return
  for (let i = 0; i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200)
    const values = []
    const params = []
    slice.forEach((r, idx) => {
      const base = idx * 7
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`)
      params.push(jobId, tenantId, moduleSlug, r.rowHash, r.rowNumber, r.operation, r.id)
    })
    await db.query(
      `INSERT INTO import_job_rows (import_job_id, tenant_id, module, row_hash, row_number, operation, record_id)
       VALUES ${values.join(',')}`,
      params
    )
  }
}

async function finishJob (db, jobId, status, counts, message) {
  await db.query(
    `UPDATE import_jobs
        SET status = $2, rows_total = $3, rows_inserted = $4, rows_updated = $5,
            rows_skipped = $6, rows_failed = $7, message = $8, finished_at = now()
      WHERE id = $1`,
    [jobId, status, counts.total, counts.inserted, counts.updated,
      counts.skipped, counts.failed, message]
  )
}

/** Error report CSV for a job (FR-IMP-009, FR-IMP-019). */
async function errorReportCsv (db, jobId) {
  const rows = await db.all(
    `SELECT row_number, column_name, error_message, raw_row
       FROM import_job_errors WHERE import_job_id = $1
      ORDER BY row_number, id`,
    [jobId]
  )
  const out = [['row_number', 'column_name', 'error_message', 'raw_row']]
  for (const row of rows) {
    out.push([row.row_number, row.column_name || '', row.error_message, row.raw_row || ''])
  }
  return formatCsv(out)
}

module.exports = {
  templateCsv,
  templateFileName,
  rowToCsv,
  runJob,
  requestCancel,
  isCancelled,
  errorReportCsv,
  validateRow,
  streamRows,
  BATCH_SIZE
}
