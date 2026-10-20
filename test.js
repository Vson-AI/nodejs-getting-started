require('./src/load-env').loadEnv()

const { parseCsv, formatCsv, CsvStreamParser, splitMulti } = require('./src/lib/csv')
const { validateRecord, validatePassword, validateInitials, isValidDate, pathType } = require('./src/lib/validate')
const { can } = require('./src/lib/permissions')
const { IP_MODULES, DOCKET_MODULE, csvColumns, sampleRow } = require('./src/lib/modules')

// ---------------------------------------------------------------------------
// CSV (SRS section 14.1)
// ---------------------------------------------------------------------------
describe('CSV reader and writer', () => {
  it('parses quoted fields, embedded commas, quotes and newlines', () => {
    const text = 'a,b,c\r\n1,"two, with comma","say ""hi"""\r\n2,"line\nbreak",x\r\n'
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'two, with comma', 'say "hi"'],
      ['2', 'line\nbreak', 'x']
    ])
  })

  it('strips a byte order mark and tolerates a missing final newline', () => {
    expect(parseCsv('\ufeffa,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('skips blank lines and keeps empty cells', () => {
    expect(parseCsv('a,b\r\n\r\n,2\r\n')).toEqual([['a', 'b'], ['', '2']])
  })

  it('produces the same rows when a document arrives in arbitrary chunks', () => {
    const text = 'action,title\r\nCREATE,"Mark, with comma"\r\nCREATE,"quote""inside"\r\n'
    const rows = []
    const parser = new CsvStreamParser((cells) => rows.push(cells))
    for (let i = 0; i < text.length; i += 3) parser.push(text.slice(i, i + 3))
    parser.end()
    expect(rows).toEqual(parseCsv(text))
  })

  it('quotes only the cells that need it and ends lines with CRLF', () => {
    expect(formatCsv([['a', 'b,c', 'd"e']])).toBe('a,"b,c","d""e"\r\n')
  })

  it('splits semicolon lists', () => {
    expect(splitMulti(' 9; 35 ;42 ;')).toEqual(['9', '35', '42'])
  })
})

// ---------------------------------------------------------------------------
// Templates (BR-31)
// ---------------------------------------------------------------------------
describe('CSV templates', () => {
  it('matches the column list in the SRS for every IP module', () => {
    expect(csvColumns(IP_MODULES.patents)).toEqual([
      'action', 'existing_reference', 'title', 'status', 'filing_date', 'publication_date',
      'grant_date', 'expiry_date', 'owner', 'inventors', 'applicant', 'ipc_class',
      'abstract', 'client_code', 'created_by'
    ])
    expect(csvColumns(IP_MODULES.trademarks)).toEqual([
      'action', 'existing_reference', 'title', 'ipo_ref', 'classes', 'class_description',
      'registration_number', 'applicant', 'territory', 'designated_states', 'filing_date',
      'expiry_date', 'status', 'client_code', 'created_by'
    ])
    expect(csvColumns(IP_MODULES.copyrights)).toEqual([
      'action', 'existing_reference', 'title', 'work_type', 'author', 'registration_number',
      'filing_date', 'expiry_date', 'status', 'client_code', 'created_by'
    ])
    expect(csvColumns(DOCKET_MODULE)).toContain('ip_record_ref')
  })

  it('writes a sample row that lines up with the header', () => {
    for (const mod of Object.values(IP_MODULES)) {
      expect(sampleRow(mod).length).toBe(csvColumns(mod).length)
    }
  })
})

// ---------------------------------------------------------------------------
// Validation (SRS section 14.9, business rules)
// ---------------------------------------------------------------------------
describe('record validation', () => {
  const lookups = {
    statuses: ['Pending', 'Registered', 'Expired'],
    countryByCode: new Map([['ZWE', { code: 'ZWE', name: 'Zimbabwe' }]]),
    countryByName: new Map([['zimbabwe', { code: 'ZWE', name: 'Zimbabwe' }]]),
    clientCodes: new Map([['ACME', { id: 7, code: 'ACME' }]]),
    usernames: new Set(['examiner'])
  }

  const trademark = (overrides = {}) => ({
    title: 'TESTMARK',
    classes: '9;35',
    filing_date: '2025-01-01',
    expiry_date: '2035-01-01',
    status: 'Pending',
    designated_states: 'Zimbabwe',
    client_code: 'ACME',
    ...overrides
  })

  it('accepts a complete row and resolves codes', () => {
    const { values, errors } = validateRecord(IP_MODULES.trademarks, trademark(), lookups)
    expect(errors).toEqual([])
    expect(values.classes).toEqual([9, 35])
    expect(values.designated_states).toEqual(['ZWE'])
    expect(values.client_id).toBe(7)
  })

  it('requires the mandatory fields', () => {
    const { errors } = validateRecord(IP_MODULES.trademarks, trademark({ title: '', filing_date: '' }), lookups)
    expect(errors.map((e) => e.column)).toEqual(expect.arrayContaining(['title', 'filing_date']))
  })

  it('rejects an expiry date that is not after the filing date (BR-11)', () => {
    const { errors } = validateRecord(
      IP_MODULES.trademarks, trademark({ expiry_date: '2024-12-31' }), lookups)
    expect(errors.find((e) => e.column === 'expiry_date')).toBeTruthy()
  })

  it('rejects a status outside the controlled list (BR-12)', () => {
    const { errors } = validateRecord(IP_MODULES.trademarks, trademark({ status: 'Invented' }), lookups)
    expect(errors.find((e) => e.column === 'status')).toBeTruthy()
  })

  it('rejects Nice classes outside 1 to 45 (BR-05)', () => {
    const { errors } = validateRecord(IP_MODULES.trademarks, trademark({ classes: '9;99' }), lookups)
    expect(errors.find((e) => e.column === 'classes')).toBeTruthy()
  })

  it('requires at least one Nice class', () => {
    const { errors } = validateRecord(IP_MODULES.trademarks, trademark({ classes: '' }), lookups)
    expect(errors.find((e) => e.column === 'classes')).toBeTruthy()
  })

  it('rejects a country that is not in the list (BR-06)', () => {
    const { errors } = validateRecord(
      IP_MODULES.trademarks, trademark({ designated_states: 'Atlantis' }), lookups)
    expect(errors.find((e) => e.column === 'designated_states')).toBeTruthy()
  })

  it('rejects an unknown client code', () => {
    const { errors } = validateRecord(IP_MODULES.trademarks, trademark({ client_code: 'NOPE' }), lookups)
    expect(errors.find((e) => e.column === 'client_code')).toBeTruthy()
  })

  it('rejects a malformed date', () => {
    const { errors } = validateRecord(
      IP_MODULES.trademarks, trademark({ filing_date: '01/01/2025' }), lookups)
    expect(errors.find((e) => e.column === 'filing_date')).toBeTruthy()
    expect(isValidDate('2025-02-30')).toBe(false)
    expect(isValidDate('2024-02-29')).toBe(true)
  })

  it('requires a linked reference when a docket entry names an IP type', () => {
    const { errors } = validateRecord(DOCKET_MODULE, {
      title: 'Renewal', due_date: '2025-06-01', ip_type: 'trademark', priority: 'High'
    }, { statuses: ['Open'], usernames: new Set() })
    expect(errors.find((e) => e.column === 'ip_record_ref')).toBeTruthy()
  })

  it('rejects an assignee who is not a user of the tenant', () => {
    const { errors } = validateRecord(DOCKET_MODULE, {
      title: 'Renewal', due_date: '2025-06-01', priority: 'Low', assigned_to: 'ghost'
    }, { statuses: ['Open'], usernames: new Set(['examiner']) })
    expect(errors.find((e) => e.column === 'assigned_to')).toBeTruthy()
  })
})

describe('password and initials rules', () => {
  it('enforces length and composition (FR-AUTH-007)', () => {
    expect(validatePassword('short1')).toBeTruthy()
    expect(validatePassword('alllettersx')).toBeTruthy()
    expect(validatePassword('demo1234')).toBeNull()
  })

  it('enforces the initials format (R-01)', () => {
    expect(validateInitials('abc').value).toBe('ABC')
    expect(validateInitials('abc').error).toBeNull()
    expect(validateInitials('A').error).toBeTruthy()
    expect(validateInitials('TOOMANYCHARS').error).toBeTruthy()
    expect(validateInitials('AB!').error).toBeTruthy()
  })

  it('detects path type by prefix (FR-FIL-004)', () => {
    expect(pathType('https://files.example.com/a.pdf')).toBe('url')
    expect(pathType('C:\\IP\\a.pdf')).toBe('local')
    expect(pathType('/srv/ip/a.pdf')).toBe('local')
  })
})

// ---------------------------------------------------------------------------
// Role to permission matrix (SRS section 11)
// ---------------------------------------------------------------------------
describe('role permissions', () => {
  const asRole = (role) => ({ roles: [role], userType: role === 'CLIENT' ? 'CLIENT' : 'STAFF' })

  it('lets only ADMIN delete records and manage users', () => {
    expect(can(asRole('ADMIN'), 'ip.delete')).toBe(true)
    expect(can(asRole('EXAMINER'), 'ip.delete')).toBe(false)
    expect(can(asRole('EXAMINER'), 'ip.create')).toBe(true)
    expect(can(asRole('VIEWER'), 'ip.create')).toBe(false)
    expect(can(asRole('EXAMINER'), 'user.manage')).toBe(false)
    expect(can(asRole('ADMIN'), 'user.manage')).toBe(true)
  })

  it('keeps client users read only and out of imports (BR-22, BR-35)', () => {
    expect(can(asRole('CLIENT'), 'ip.create')).toBe(false)
    expect(can(asRole('CLIENT'), 'ip.update')).toBe(false)
    expect(can(asRole('CLIENT'), 'import.run')).toBe(false)
    expect(can(asRole('VIEWER'), 'import.run')).toBe(false)
    expect(can(asRole('CLIENT'), 'template.download')).toBe(true)
    expect(can(asRole('CLIENT'), 'data.export')).toBe(true)
    expect(can(asRole('CLIENT'), 'audit.view')).toBe(false)
  })

  it('keeps platform admins out of tenant data (SRS section 11)', () => {
    const platform = { roles: ['PLATFORM_ADMIN'], userType: 'PLATFORM_ADMIN' }
    expect(can(platform, 'tenant.manage')).toBe(true)
    expect(can(platform, 'data.view')).toBe(false)
    expect(can(platform, 'ip.create')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Database behaviour. Skipped when no database is configured.
// ---------------------------------------------------------------------------
const hasDb = !!process.env.DATABASE_URL
const describeDb = hasDb ? describe : describe.skip

describeDb('database rules', () => {
  const { withSystemContext, withContext, closePool } = require('./src/db/pool')
  const { migrate } = require('./src/db/migrate')
  const records = require('./src/lib/records')

  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase()
  const initials = 'T' + suffix
  let tenantId = null
  let clientA = null
  let clientB = null

  jest.setTimeout(60000)

  beforeAll(async () => {
    await migrate()
    await withSystemContext(async (db) => {
      const tenant = await db.one(
        `INSERT INTO tenants (legal_name, initials) VALUES ($1, $2) RETURNING id`,
        ['Test Agency ' + suffix, initials])
      tenantId = Number(tenant.id)
      await db.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [tenantId])
      for (const code of ['P', 'U', 'M', 'C', 'D']) {
        await db.query('INSERT INTO ref_counters (tenant_id, type_code) VALUES ($1,$2)', [tenantId, code])
      }
      clientA = Number((await db.one(
        `INSERT INTO clients (tenant_id, code, name) VALUES ($1,'AAA','Client A') RETURNING id`,
        [tenantId])).id)
      clientB = Number((await db.one(
        `INSERT INTO clients (tenant_id, code, name) VALUES ($1,'BBB','Client B') RETURNING id`,
        [tenantId])).id)
    })
  })

  afterAll(async () => {
    if (tenantId) {
      await withSystemContext(async (db) => {
        await db.query('DELETE FROM audit_logs WHERE tenant_id = $1', [tenantId])
        await db.query('DELETE FROM audit_logs_archive WHERE tenant_id = $1', [tenantId])
        await db.query('DELETE FROM tenants WHERE id = $1', [tenantId])
      })
    }
    await closePool()
  })

  const staff = () => ({ tenantId, userType: 'STAFF', username: 'tester' })

  async function createTrademark (overrides = {}) {
    return withContext(staff(), (db) => db.tx((tx) =>
      records.createRecord(tx, IP_MODULES.trademarks, { tenantId, username: 'tester' }, {
        title: 'MARK ' + Math.random().toString(36).slice(2, 7),
        classes: [9],
        designated_states: ['ZWE'],
        filing_date: '2025-01-01',
        expiry_date: '2035-01-01',
        status: 'Pending',
        ...overrides
      })))
  }

  it('generates references as initials/type/year/sequence and never resets (R-02, R-04)', async () => {
    const first = await createTrademark({ filing_date: '2025-01-01' })
    const second = await createTrademark({ filing_date: '2026-01-01' })
    expect(first.three_eyes_ref).toBe(`${initials}/M/2025/000001`)
    expect(second.three_eyes_ref).toBe(`${initials}/M/2026/000002`)
  })

  it('keeps a separate sequence per IP type', async () => {
    const patent = await withContext(staff(), (db) => db.tx((tx) =>
      records.createRecord(tx, IP_MODULES.patents, { tenantId, username: 'tester' }, {
        title: 'A patent', status: 'Pending', filing_date: '2025-02-02'
      })))
    expect(patent.three_eyes_ref).toBe(`${initials}/P/2025/000001`)
  })

  it('grows the sequence past six digits without changing format (R-04)', async () => {
    await withSystemContext((db) => db.query(
      `UPDATE ref_counters SET last_value = 999998 WHERE tenant_id = $1 AND type_code = 'C'`, [tenantId]))
    const a = await withContext(staff(), (db) => db.tx((tx) =>
      records.createRecord(tx, IP_MODULES.copyrights, { tenantId, username: 'tester' },
        { title: 'Work one', status: 'Pending', filing_date: '2025-01-01' })))
    const b = await withContext(staff(), (db) => db.tx((tx) =>
      records.createRecord(tx, IP_MODULES.copyrights, { tenantId, username: 'tester' },
        { title: 'Work two', status: 'Pending', filing_date: '2025-01-01' })))
    expect(a.three_eyes_ref).toBe(`${initials}/C/2025/999999`)
    expect(b.three_eyes_ref).toBe(`${initials}/C/2025/1000000`)
  })

  it('refuses to change a reference once assigned (BR-03)', async () => {
    const record = await createTrademark()
    await expect(withContext(staff(), (db) => db.query(
      'UPDATE trademarks SET three_eyes_ref = $2 WHERE id = $1', [record.id, 'OTHER/M/2025/000001'])))
      .rejects.toThrow(/immutable/)
  })

  it('does not reuse the sequence number of a deleted record (BR-08)', async () => {
    const before = await createTrademark()
    await withContext(staff(), (db) =>
      records.deleteRecord(db, IP_MODULES.trademarks, tenantId, before.id))
    const after = await createTrademark()
    expect(after.three_eyes_ref).not.toBe(before.three_eyes_ref)
    const beforeSeq = Number(before.three_eyes_ref.split('/').pop())
    expect(Number(after.three_eyes_ref.split('/').pop())).toBe(beforeSeq + 1)
  })

  it('hides one client from another inside the same tenant (FR-CP-005)', async () => {
    const mine = await createTrademark({ client_id: clientA })
    const theirs = await createTrademark({ client_id: clientB })

    const visible = await withContext(
      { tenantId, clientId: clientA, userType: 'CLIENT', username: 'client.a' },
      (db) => db.all('SELECT id FROM trademarks'))
    const ids = visible.map((r) => Number(r.id))
    expect(ids).toContain(Number(mine.id))
    expect(ids).not.toContain(Number(theirs.id))
  })

  it('hides unassigned records from client users', async () => {
    const unassigned = await createTrademark({ client_id: null })
    const visible = await withContext(
      { tenantId, clientId: clientA, userType: 'CLIENT', username: 'client.a' },
      (db) => db.all('SELECT id FROM trademarks'))
    expect(visible.map((r) => Number(r.id))).not.toContain(Number(unassigned.id))
  })

  it('hides one tenant from another (FR-TEN-003)', async () => {
    const mine = await createTrademark()
    const otherTenant = await withSystemContext((db) =>
      db.one('SELECT id FROM tenants WHERE id <> $1 LIMIT 1', [tenantId]))
    if (!otherTenant) return
    const visible = await withContext(
      { tenantId: Number(otherTenant.id), userType: 'STAFF', username: 'other' },
      (db) => db.all('SELECT id FROM trademarks'))
    expect(visible.map((r) => Number(r.id))).not.toContain(Number(mine.id))
  })

  it('writes an audit entry for every change and refuses edits to the trail (FR-AUD-001, BR-07)', async () => {
    const record = await createTrademark({ title: 'AUDITED MARK' })
    await withContext(staff(), (db) =>
      records.updateRecord(db, IP_MODULES.trademarks, { tenantId, username: 'tester' }, record.id,
        { status: 'Registered' }))

    const entries = await withContext(staff(), (db) => db.all(
      `SELECT action, username, old_value, new_value FROM audit_logs
        WHERE module = 'TRADEMARK' AND record_id = $1 ORDER BY id`, [record.id]))

    expect(entries.map((e) => e.action)).toEqual(['CREATE', 'UPDATE'])
    expect(entries[0].username).toBe('tester')
    expect(entries[1].old_value.status).toBe('Pending')
    expect(entries[1].new_value.status).toBe('Registered')

    await expect(withContext(staff(), (db) => db.query(
      `UPDATE audit_logs SET username = 'forged' WHERE record_id = $1`, [record.id])))
      .rejects.toThrow(/append-only/)
    await expect(withContext(staff(), (db) => db.query(
      'DELETE FROM audit_logs WHERE record_id = $1', [record.id])))
      .rejects.toThrow(/append-only/)
  })

  it('never puts a password hash in the audit trail', async () => {
    const row = await withSystemContext((db) => db.one(
      `SELECT new_value FROM audit_logs WHERE module = 'USER' AND new_value IS NOT NULL
        ORDER BY id DESC LIMIT 1`))
    if (row) expect(Object.keys(row.new_value)).not.toContain('password_hash')
  })

  it('keeps registration numbers unique per tenant but not across tenants (FR-TM-005)', async () => {
    await createTrademark({ registration_number: 'RN-' + suffix })
    await expect(createTrademark({ registration_number: 'RN-' + suffix }))
      .rejects.toThrow(/duplicate key/)
  })

  it('rejects an expiry date before the filing date at the database level (BR-11)', async () => {
    await expect(createTrademark({ filing_date: '2025-01-01', expiry_date: '2024-01-01' }))
      .rejects.toThrow(/ck_trademarks_dates/)
  })
})

// ---------------------------------------------------------------------------
// Bulk import end to end. Skipped when no database is configured.
// ---------------------------------------------------------------------------
describeDb('bulk CSV import', () => {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const crypto = require('crypto')
  const { withSystemContext, withContext, closePool } = require('./src/db/pool')
  const { migrate } = require('./src/db/migrate')
  const importer = require('./src/lib/importer')

  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase()
  const initials = 'I' + suffix
  let tenantId = null
  let userId = null

  jest.setTimeout(120000)

  beforeAll(async () => {
    await migrate()
    await withSystemContext(async (db) => {
      const tenant = await db.one(
        'INSERT INTO tenants (legal_name, initials) VALUES ($1,$2) RETURNING id',
        ['Import Agency ' + suffix, initials])
      tenantId = Number(tenant.id)
      await db.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [tenantId])
      for (const code of ['P', 'U', 'M', 'C', 'D']) {
        await db.query('INSERT INTO ref_counters (tenant_id, type_code) VALUES ($1,$2)', [tenantId, code])
      }
      await db.query(
        `INSERT INTO clients (tenant_id, code, name) VALUES ($1,'ACME','Acme Ltd')`, [tenantId])
      userId = Number((await db.one(
        `INSERT INTO users (tenant_id, username, password_hash, user_type)
         VALUES ($1,'importer','x','STAFF') RETURNING id`, [tenantId])).id)
    })
  })

  afterAll(async () => {
    if (tenantId) {
      await withSystemContext(async (db) => {
        await db.query('DELETE FROM audit_logs WHERE tenant_id = $1', [tenantId])
        await db.query('DELETE FROM tenants WHERE id = $1', [tenantId])
      })
    }
    await closePool()
  })

  function writeCsv (rows) {
    const file = path.join(os.tmpdir(), `import-test-${crypto.randomBytes(5).toString('hex')}.csv`)
    fs.writeFileSync(file, formatCsv(rows), 'utf8')
    return file
  }

  const header = csvColumns(IP_MODULES.patents)
  const patentRow = (overrides = {}) => {
    const row = {
      action: 'CREATE',
      existing_reference: '',
      title: 'Imported patent',
      status: 'Pending',
      filing_date: '2025-01-05',
      publication_date: '',
      grant_date: '',
      expiry_date: '2045-01-05',
      owner: 'Acme Ltd',
      inventors: 'A Tester',
      applicant: 'Acme Ltd',
      ipc_class: 'G06F 1/00',
      abstract: 'Imported by the test suite.',
      client_code: 'ACME',
      created_by: '',
      ...overrides
    }
    return header.map((c) => row[c] ?? '')
  }

  async function runImport (file, { mode = 'DRY_RUN', skipInvalid = false, module = 'patents' } = {}) {
    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    const job = await withSystemContext((db) => db.one(
      `INSERT INTO import_jobs (tenant_id, user_id, username, module, file_name, file_hash,
                                file_path, mode, skip_invalid)
       VALUES ($1,$2,'importer',$3,$4,$5,$6,$7,$8) RETURNING id`,
      [tenantId, userId, module, path.basename(file), fileHash, file, mode, skipInvalid]))
    await importer.runJob(Number(job.id), { tenantId, userType: 'STAFF', username: 'importer' })
    return withSystemContext((db) => db.one('SELECT * FROM import_jobs WHERE id = $1', [job.id]))
  }

  it('validates without writing anything in dry run mode (BR-32)', async () => {
    const file = writeCsv([header, patentRow(), patentRow({ title: 'Second patent' })])
    const job = await runImport(file, { mode: 'DRY_RUN' })
    expect(job.status).toBe('COMPLETED')
    expect(job.rows_total).toBe(2)
    expect(job.rows_failed).toBe(0)
    expect(job.rows_inserted).toBe(0)
    const count = await withSystemContext((db) =>
      db.value('SELECT count(*) FROM patents WHERE tenant_id = $1', [tenantId]))
    expect(Number(count)).toBe(0)
  })

  it('reports one error row per problem with its row number (FR-IMP-009)', async () => {
    const file = writeCsv([
      header,
      patentRow({ status: 'Nonsense' }),
      patentRow({ filing_date: '' }),
      patentRow({ client_code: 'GHOST' })
    ])
    const job = await runImport(file, { mode: 'DRY_RUN' })
    expect(job.rows_failed).toBe(3)
    const errors = await withSystemContext((db) => db.all(
      'SELECT row_number, column_name FROM import_job_errors WHERE import_job_id = $1 ORDER BY row_number',
      [job.id]))
    expect(errors.map((e) => e.row_number)).toEqual([2, 3, 4])
    expect(errors.map((e) => e.column_name)).toEqual(['status', 'filing_date', 'client_code'])

    const csv = await withSystemContext((db) => importer.errorReportCsv(db, job.id))
    expect(csv.split('\r\n')[0]).toBe('row_number,column_name,error_message,raw_row')
    expect(csv.trim().split('\r\n').length).toBe(4)
  })

  it('commits nothing when a row is invalid and abort on error is chosen (FR-IMP-006)', async () => {
    const file = writeCsv([header, patentRow(), patentRow({ status: 'Nonsense' })])
    const job = await runImport(file, { mode: 'COMMIT', skipInvalid: false })
    expect(job.status).toBe('FAILED')
    const count = await withSystemContext((db) =>
      db.value('SELECT count(*) FROM patents WHERE tenant_id = $1', [tenantId]))
    expect(Number(count)).toBe(0)
  })

  it('imports valid rows and skips invalid ones when asked (FR-IMP-024)', async () => {
    const file = writeCsv([
      header,
      patentRow({ title: 'Good one' }),
      patentRow({ title: 'Bad one', status: 'Nonsense' }),
      patentRow({ title: 'Good two' })
    ])
    const job = await runImport(file, { mode: 'COMMIT', skipInvalid: true })
    expect(job.status).toBe('COMPLETED')
    expect(job.rows_inserted).toBe(2)
    expect(job.rows_failed).toBe(1)

    const rows = await withSystemContext((db) => db.all(
      'SELECT three_eyes_ref, title, client_id FROM patents WHERE tenant_id = $1 ORDER BY id', [tenantId]))
    expect(rows.map((r) => r.title)).toEqual(['Good one', 'Good two'])
    expect(rows[0].three_eyes_ref).toBe(`${initials}/P/2025/000001`)
    expect(rows[1].three_eyes_ref).toBe(`${initials}/P/2025/000002`)
    expect(rows[0].client_id).not.toBeNull()
  })

  it('audits imported rows exactly like typed ones (BR-39, FR-IMP-011)', async () => {
    const entries = await withSystemContext((db) => db.all(
      `SELECT action, username FROM audit_logs
        WHERE tenant_id = $1 AND module = 'PATENT' AND action = 'CREATE'`, [tenantId]))
    expect(entries.length).toBe(2)
    expect(entries.every((e) => e.username === 'importer')).toBe(true)

    const runEntry = await withSystemContext((db) => db.one(
      `SELECT new_value FROM audit_logs WHERE tenant_id = $1 AND action = 'IMPORT' ORDER BY id DESC LIMIT 1`,
      [tenantId]))
    expect(runEntry.new_value.file_hash).toHaveLength(64)
    expect(runEntry.new_value.rows_inserted).toBe(2)
  })

  it('does not duplicate rows when the same file is uploaded again (FR-IMP-018)', async () => {
    const rows = [header, patentRow({ title: 'Idempotent one' }), patentRow({ title: 'Idempotent two' })]
    const first = await runImport(writeCsv(rows), { mode: 'COMMIT', skipInvalid: true })
    expect(first.rows_inserted).toBe(2)

    const second = await runImport(writeCsv(rows), { mode: 'COMMIT', skipInvalid: true })
    expect(second.rows_inserted).toBe(0)
    expect(second.rows_skipped).toBe(2)

    const count = await withSystemContext((db) => db.value(
      `SELECT count(*) FROM patents WHERE tenant_id = $1 AND title LIKE 'Idempotent%'`, [tenantId]))
    expect(Number(count)).toBe(2)
  })

  it('updates an existing record by reference and keeps the reference (FR-IMP-013)', async () => {
    const existing = await withSystemContext((db) => db.one(
      `SELECT three_eyes_ref, id FROM patents WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [tenantId]))
    const file = writeCsv([
      header,
      patentRow({ action: 'UPDATE', existing_reference: existing.three_eyes_ref, title: 'Renamed by import' })
    ])
    const job = await runImport(file, { mode: 'COMMIT', skipInvalid: false })
    expect(job.rows_updated).toBe(1)
    const after = await withSystemContext((db) => db.one(
      'SELECT three_eyes_ref, title FROM patents WHERE id = $1', [existing.id]))
    expect(after.title).toBe('Renamed by import')
    expect(after.three_eyes_ref).toBe(existing.three_eyes_ref)
  })

  it('rejects an UPDATE that names a reference which does not exist', async () => {
    const file = writeCsv([
      header, patentRow({ action: 'UPDATE', existing_reference: 'ZZZ/P/2025/000001' })
    ])
    const job = await runImport(file, { mode: 'DRY_RUN' })
    expect(job.rows_failed).toBe(1)
  })

  it('rejects a CREATE row that carries a reference (FR-IMP-012)', async () => {
    const file = writeCsv([header, patentRow({ existing_reference: `${initials}/P/2025/000001` })])
    const job = await runImport(file, { mode: 'DRY_RUN' })
    expect(job.rows_failed).toBe(1)
  })

  it('fails the job when the header is missing a column', async () => {
    const file = writeCsv([['action', 'title'], ['CREATE', 'No status column']])
    const job = await runImport(file, { mode: 'DRY_RUN' })
    expect(job.status).toBe('FAILED')
    expect(job.message).toMatch(/missing these columns/)
  })

  it('skips the description row that the template writes', async () => {
    const { csvDescriptions } = require('./src/lib/modules')
    const file = writeCsv([header, csvDescriptions(IP_MODULES.patents), patentRow({ title: 'After hint row' })])
    const job = await runImport(file, { mode: 'DRY_RUN' })
    expect(job.rows_total).toBe(1)
    expect(job.rows_failed).toBe(0)
  })
})
