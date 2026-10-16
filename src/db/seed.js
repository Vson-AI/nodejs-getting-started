require('../load-env').loadEnv()
const bcrypt = require('bcryptjs')
const { withSystemContext, withContext, closePool } = require('./pool')
const { IP_MODULES } = require('../lib/modules')
const records = require('../lib/records')

/**
 * Demonstration data: two agencies so tenant isolation is visible, each with
 * clients, portal accounts and a populated portfolio. Runs only when the
 * database has no tenants yet.
 */
const DEMO_PASSWORD = 'demo1234'

function daysFromNow (n) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function createUser (db, { tenantId, clientId, username, fullName, email, roles, userType }) {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10)
  const row = await db.one(
    `INSERT INTO users (tenant_id, client_id, username, full_name, email, password_hash, user_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tenantId, clientId, username, fullName, email, hash, userType]
  )
  for (const role of roles) {
    await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [row.id, role])
  }
  return row.id
}

async function createTenant (db, { legalName, initials, email }) {
  const tenant = await db.one(
    `INSERT INTO tenants (legal_name, initials, contact_email, status, plan_id)
     VALUES ($1,$2,$3,'ACTIVE', (SELECT id FROM plans WHERE code = 'PRACTICE'))
     RETURNING *`,
    [legalName, initials, email]
  )
  await db.query('INSERT INTO tenant_settings (tenant_id, file_base_dir, file_cloud_prefix) VALUES ($1,$2,$3)',
    [tenant.id, `/srv/ip-files/${initials.toLowerCase()}`, 'https://files.example.com/'])
  for (const code of ['P', 'U', 'M', 'C', 'D']) {
    await db.query('INSERT INTO ref_counters (tenant_id, type_code, last_value) VALUES ($1,$2,0)', [tenant.id, code])
  }
  return tenant
}

async function createClient (db, tenantId, client) {
  return db.one(
    `INSERT INTO clients (tenant_id, code, name, contact_person, email, phone, address, tax_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tenantId, client.code, client.name, client.contact, client.email,
      client.phone, client.address, client.tax]
  )
}

const ABC_DATA = {
  patents: [
    { title: 'Solar powered borehole pump controller', status: 'Granted', filing_date: '2019-04-11', publication_date: '2020-01-20', grant_date: '2021-08-03', expiry_date: '2039-04-11', owner: 'Helio Labs Ltd', inventors: 'T Moyo;R Banda', applicant: 'Helio Labs Ltd', ipc_class: 'F04B 49/06', abstract: 'A controller that matches pump speed to available solar power.', client: 'HELIO' },
    { title: 'Low cost soil moisture probe', status: 'Published', filing_date: '2022-02-02', publication_date: '2023-08-14', expiry_date: '2042-02-02', owner: 'Helio Labs Ltd', inventors: 'R Banda', applicant: 'Helio Labs Ltd', ipc_class: 'G01N 27/04', abstract: 'A capacitive probe moulded in a single piece.', client: 'HELIO' },
    { title: 'Modular cold chain container', status: 'Pending', filing_date: '2024-06-18', expiry_date: '2044-06-18', owner: 'Kopje Holdings', inventors: 'L Chikwava;P Ncube', applicant: 'Kopje Holdings', ipc_class: 'F25D 3/08', abstract: 'A container that stacks into a passive cold store.', client: 'KOPJE' },
    { title: 'Reinforced thatch fixing bracket', status: 'Lapsed', filing_date: '2016-09-30', grant_date: '2018-05-22', expiry_date: '2036-09-30', owner: 'Kopje Holdings', inventors: 'P Ncube', applicant: 'Kopje Holdings', ipc_class: 'E04D 12/00', abstract: 'A bracket that anchors thatch without wire ties.', client: 'KOPJE' },
    { title: 'Water reuse filter cartridge', status: 'Pending', filing_date: '2025-01-09', expiry_date: '2045-01-09', owner: 'Sable Foods', inventors: 'A Dube', applicant: 'Sable Foods', ipc_class: 'C02F 1/00', abstract: 'A cartridge for reusing process water in food plants.', client: 'SABLE' }
  ],
  'utility-models': [
    { title: 'Clip-on bicycle cargo rack', status: 'Granted', filing_date: '2023-05-02', grant_date: '2023-11-15', expiry_date: '2033-05-02', owner: 'Kopje Holdings', inventors: 'L Chikwava', applicant: 'Kopje Holdings', ipc_class: 'B62J 7/04', abstract: 'A rack that clamps to a seat post without tools.', client: 'KOPJE' },
    { title: 'Stackable seedling tray', status: 'Pending', filing_date: '2024-09-12', expiry_date: '2034-09-12', owner: 'Sable Foods', inventors: 'A Dube', applicant: 'Sable Foods', ipc_class: 'A01G 9/02', abstract: 'A tray that stacks without crushing seedlings.', client: 'SABLE' },
    { title: 'Hand operated maize sheller', status: 'Expired', filing_date: '2012-03-21', grant_date: '2012-12-04', expiry_date: '2022-03-21', owner: 'Helio Labs Ltd', inventors: 'T Moyo', applicant: 'Helio Labs Ltd', ipc_class: 'A01F 11/06', abstract: 'A sheller driven by a single crank.', client: 'HELIO' }
  ],
  trademarks: [
    { title: 'KOPJE', ipo_ref: 'IPO/2021/1180', classes: [9, 35, 42], class_description: 'Software; retail services; design services', registration_number: 'TM-2021-1180', applicant: 'Kopje Holdings', territory: 'Zimbabwe', designated_states: ['ZWE', 'ZAF', 'BWA'], filing_date: '2021-03-15', expiry_date: '2031-03-15', status: 'Registered', client: 'KOPJE' },
    { title: 'HELIO LABS', ipo_ref: 'IPO/2022/0442', classes: [7, 9, 11], class_description: 'Pumps; controllers; solar apparatus', registration_number: 'TM-2022-0442', applicant: 'Helio Labs Ltd', territory: 'Zimbabwe', designated_states: ['ZWE', 'ZMB', 'MWI'], filing_date: '2022-07-01', expiry_date: '2032-07-01', status: 'Registered', client: 'HELIO' },
    { title: 'SABLE HARVEST', ipo_ref: 'IPO/2024/2231', classes: [29, 30, 31], class_description: 'Preserved foods; cereals; fresh produce', applicant: 'Sable Foods', territory: 'ARIPO', designated_states: ['ZWE', 'BWA', 'NAM', 'MOZ'], filing_date: '2024-11-04', expiry_date: '2034-11-04', status: 'Pending', client: 'SABLE' },
    { title: 'VELD & VINE', ipo_ref: 'IPO/2025/0098', classes: [33], class_description: 'Wines and spirits', applicant: 'Sable Foods', territory: 'Zimbabwe', designated_states: ['ZWE'], filing_date: '2025-02-19', expiry_date: '2035-02-19', status: 'Opposed', client: 'SABLE' },
    { title: 'MUSASA', ipo_ref: 'IPO/2020/0771', classes: [36, 41], class_description: 'Financial services; education', registration_number: 'TM-2020-0771', applicant: 'Kopje Holdings', territory: 'Zimbabwe', designated_states: ['ZWE', 'ZAF'], filing_date: '2020-05-08', expiry_date: daysFromNow(54), status: 'Registered', client: 'KOPJE' }
  ],
  copyrights: [
    { title: 'Harvest Songs, volume two', work_type: 'Musical work', author: 'N Dube', registration_number: 'CR-2023-0007', filing_date: '2023-02-11', expiry_date: '2093-02-11', status: 'Registered', client: 'SABLE' },
    { title: 'Borehole controller firmware', work_type: 'Software', author: 'Helio Labs engineering team', registration_number: 'CR-2021-0051', filing_date: '2021-06-30', expiry_date: '2071-06-30', status: 'Registered', client: 'HELIO' },
    { title: 'Field operations handbook', work_type: 'Literary work', author: 'L Chikwava', filing_date: '2025-03-03', status: 'Pending', client: 'KOPJE' }
  ],
  designs: [
    { title: 'Stackable water container', locarno_class: '09-01', registration_number: 'ID-2023-0033', applicant: 'Kopje Holdings', filing_date: '2023-04-08', expiry_date: '2038-04-08', status: 'Registered', client: 'KOPJE' },
    { title: 'Solar pump housing', locarno_class: '15-99', applicant: 'Helio Labs Ltd', filing_date: '2024-10-22', expiry_date: '2039-10-22', status: 'Pending', client: 'HELIO' },
    { title: 'Preserve jar label frame', locarno_class: '19-08', registration_number: 'ID-2019-0014', applicant: 'Sable Foods', filing_date: '2019-01-15', expiry_date: daysFromNow(21), status: 'Registered', client: 'SABLE' }
  ]
}

async function seedTenantData (tenant, clientsByCode, username) {
  await withContext(
    { tenantId: tenant.id, userType: 'STAFF', username },
    async (db) => {
      const created = {}
      for (const [slug, rows] of Object.entries(ABC_DATA)) {
        const mod = IP_MODULES[slug]
        created[slug] = []
        for (const row of rows) {
          const { client, ...values } = row
          values.client_id = client ? clientsByCode[client].id : null
          const record = await db.tx((tx) =>
            records.createRecord(tx, mod, { tenantId: tenant.id, username }, values))
          created[slug].push(record)
        }
      }

      const tm = created.trademarks
      const pat = created.patents
      const dockets = [
        { ip_type: 'trademark', ref: tm[2].three_eyes_ref, id: tm[2].id, client_id: tm[2].client_id, title: 'File response to examination report', description: 'Office action issued on the ARIPO filing.', due_date: daysFromNow(9), assigned_to: 'examiner', status: 'Open', status_date: daysFromNow(-20), action_due: 'Response filing', action_due_date: daysFromNow(7), priority: 'High', documents: '/srv/ip-files/abc/office-action-2231.pdf;https://files.example.com/oa-2231.pdf' },
        { ip_type: 'trademark', ref: tm[4].three_eyes_ref, id: tm[4].id, client_id: tm[4].client_id, title: 'Renewal of MUSASA registration', description: 'Ten year renewal falls due.', due_date: daysFromNow(40), assigned_to: 'examiner', status: 'Open', priority: 'Medium', certificate: 'https://files.example.com/musasa-certificate.pdf' },
        { ip_type: 'trademark', ref: tm[3].three_eyes_ref, id: tm[3].id, client_id: tm[3].client_id, title: 'Prepare opposition defence', description: 'Third party opposition filed against VELD & VINE.', due_date: daysFromNow(-6), assigned_to: 'admin', status: 'In Progress', status_date: daysFromNow(-13), action_due: 'Counter statement', action_due_date: daysFromNow(-6), priority: 'High' },
        { ip_type: 'patent', ref: pat[2].three_eyes_ref, id: pat[2].id, client_id: pat[2].client_id, title: 'Pay third annuity', due_date: daysFromNow(25), assigned_to: 'admin', status: 'Open', priority: 'Medium' },
        { ip_type: 'patent', ref: pat[4].three_eyes_ref, id: pat[4].id, client_id: pat[4].client_id, title: 'Request substantive examination', due_date: daysFromNow(-2), assigned_to: 'examiner', status: 'Open', priority: 'High' },
        { ip_type: 'patent', ref: pat[0].three_eyes_ref, id: pat[0].id, client_id: pat[0].client_id, title: 'Record assignment to Helio Labs', due_date: daysFromNow(-45), assigned_to: 'admin', status: 'Completed', status_date: daysFromNow(-44), priority: 'Low', completed: true },
        { title: 'Quarterly portfolio review with Kopje', description: 'No linked record; internal meeting.', due_date: daysFromNow(16), assigned_to: 'admin', status: 'Open', priority: 'Low', client_id: clientsByCode.KOPJE.id }
      ]

      for (const entry of dockets) {
        const { ref, id, completed, ...rest } = entry
        const row = await records.createDocket(db, { tenantId: tenant.id, username }, {
          ...rest,
          ip_record_ref: ref || null,
          ip_record_id: id || null
        })
        if (completed) {
          await records.updateDocket(db, { tenantId: tenant.id, username }, row.id, { completed: true })
        }
      }
    }
  )
}

async function seed () {
  const already = await withSystemContext((db) => db.value('SELECT count(*) FROM tenants'))
  if (Number(already) > 0) {
    console.log('Tenants already exist; nothing seeded.')
    return false
  }

  const { tenant, clients } = await withSystemContext(async (db) => {
    await createUser(db, {
      tenantId: null,
      clientId: null,
      username: 'platform',
      fullName: 'Platform administrator',
      email: 'platform@example.com',
      userType: 'PLATFORM_ADMIN',
      roles: ['PLATFORM_ADMIN']
    })

    const abc = await createTenant(db, {
      legalName: 'ABC Intellectual Property Advisors',
      initials: 'ABC',
      email: 'registry@abc-ip.example'
    })

    const clientRows = {}
    for (const client of [
      { code: 'KOPJE', name: 'Kopje Holdings', contact: 'L Chikwava', email: 'ip@kopje.example', phone: '+263 242 700 100', address: '14 Josiah Chinamano Ave, Harare', tax: 'VAT-4410029' },
      { code: 'HELIO', name: 'Helio Labs Ltd', contact: 'T Moyo', email: 'legal@heliolabs.example', phone: '+263 292 884 221', address: '7 Fife Street, Bulawayo', tax: 'VAT-2210884' },
      { code: 'SABLE', name: 'Sable Foods', contact: 'A Dube', email: 'brands@sablefoods.example', phone: '+263 242 338 990', address: '41 Enterprise Road, Harare', tax: 'VAT-7781200' }
    ]) {
      clientRows[client.code] = await createClient(db, abc.id, client)
    }

    await createUser(db, { tenantId: abc.id, clientId: null, username: 'admin', fullName: 'Rudo Masuku', email: 'rudo@abc-ip.example', userType: 'STAFF', roles: ['ADMIN'] })
    await createUser(db, { tenantId: abc.id, clientId: null, username: 'examiner', fullName: 'Farai Nyoni', email: 'farai@abc-ip.example', userType: 'STAFF', roles: ['EXAMINER'] })
    await createUser(db, { tenantId: abc.id, clientId: null, username: 'viewer', fullName: 'Tendai Shoko', email: 'tendai@abc-ip.example', userType: 'STAFF', roles: ['VIEWER'] })
    await createUser(db, { tenantId: abc.id, clientId: clientRows.KOPJE.id, username: 'kopje.user', fullName: 'Lerato Chikwava', email: 'ip@kopje.example', userType: 'CLIENT', roles: ['CLIENT'] })
    await createUser(db, { tenantId: abc.id, clientId: clientRows.HELIO.id, username: 'helio.user', fullName: 'Tapiwa Moyo', email: 'legal@heliolabs.example', userType: 'CLIENT', roles: ['CLIENT'] })

    // A second agency proves isolation: same type codes, independent counters.
    const zim = await createTenant(db, {
      legalName: 'Zimipo Patent Agents',
      initials: 'ZIMIPO',
      email: 'mail@zimipo.example'
    })
    const zimClient = await createClient(db, zim.id, {
      code: 'NDEBA', name: 'Ndebele Brewing', contact: 'S Ndlovu', email: 'ip@ndebabrew.example', phone: '+263 292 441 220', address: '2 Leopold Takawira Ave, Bulawayo', tax: 'VAT-9980112'
    })
    await createUser(db, { tenantId: zim.id, clientId: null, username: 'admin', fullName: 'Sipho Ndlovu', email: 'sipho@zimipo.example', userType: 'STAFF', roles: ['ADMIN'] })
    await createUser(db, { tenantId: zim.id, clientId: zimClient.id, username: 'ndeba.user', fullName: 'Nomsa Sibanda', email: 'ip@ndebabrew.example', userType: 'CLIENT', roles: ['CLIENT'] })

    return { tenant: abc, clients: clientRows, zim, zimClient }
  })

  await seedTenantData(tenant, clients, 'admin')

  // One record in the second agency: its sequence starts at 1 again.
  const zim = await withSystemContext((db) => db.one(`SELECT * FROM tenants WHERE initials = 'ZIMIPO'`))
  const zimClient = await withSystemContext((db) =>
    db.one('SELECT * FROM clients WHERE tenant_id = $1', [zim.id]))
  await withContext({ tenantId: zim.id, userType: 'STAFF', username: 'admin' }, async (db) => {
    await db.tx((tx) => records.createRecord(tx, IP_MODULES.trademarks,
      { tenantId: zim.id, username: 'admin' }, {
        title: 'NDEBA GOLD',
        ipo_ref: 'IPO/2024/8814',
        classes: [32, 33],
        class_description: 'Beers; alcoholic beverages',
        registration_number: 'TM-2024-8814',
        applicant: 'Ndebele Brewing',
        territory: 'Zimbabwe',
        designated_states: ['ZWE'],
        filing_date: '2024-08-19',
        expiry_date: '2034-08-19',
        status: 'Registered',
        client_id: zimClient.id
      }))
  })

  console.log('Seeded demo tenants ABC and ZIMIPO.')
  return true
}

if (require.main === module) {
  seed()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err)
      await closePool()
      process.exit(1)
    })
}

module.exports = { seed, DEMO_PASSWORD }
