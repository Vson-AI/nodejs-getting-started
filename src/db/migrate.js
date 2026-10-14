require('../load-env').loadEnv()
const fs = require('fs')
const path = require('path')
const { withSystemContext } = require('./pool')
const { COUNTRIES } = require('./countries')
const { STATUS_LISTS } = require('../lib/modules')

const PLANS = [
  { code: 'TRIAL', name: 'Trial', max_users: 3, max_clients: 5, max_ip_records: 100, max_storage_mb: 512 },
  { code: 'PRACTICE', name: 'Practice', max_users: 15, max_clients: 100, max_ip_records: 10000, max_storage_mb: 10240 },
  { code: 'FIRM', name: 'Firm', max_users: 100, max_clients: 1000, max_ip_records: 250000, max_storage_mb: 102400 }
]

/** Create or update the schema, then top up the global reference data. */
async function migrate () {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  await withSystemContext(async (db) => {
    await db.query(sql)

    for (const plan of PLANS) {
      await db.query(
        `INSERT INTO plans (code, name, max_users, max_clients, max_ip_records, max_storage_mb)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
        [plan.code, plan.name, plan.max_users, plan.max_clients, plan.max_ip_records, plan.max_storage_mb]
      )
    }

    const existing = Number(await db.value('SELECT count(*) FROM countries WHERE tenant_id IS NULL'))
    if (existing < COUNTRIES.length) {
      for (const country of COUNTRIES) {
        await db.query(
          `INSERT INTO countries (code, name, tenant_id) VALUES ($1, $2, NULL)
           ON CONFLICT DO NOTHING`,
          [country.code, country.name]
        )
      }
    }

    for (const [ipType, list] of Object.entries(STATUS_LISTS)) {
      for (const [i, value] of list.entries()) {
        await db.query(
          `INSERT INTO status_options (tenant_id, ip_type, value, sort_order)
           VALUES (NULL, $1, $2, $3) ON CONFLICT DO NOTHING`,
          [ipType, value, i * 10]
        )
      }
    }
  })
}

if (require.main === module) {
  migrate()
    .then(() => {
      console.log('Schema is up to date.')
      return require('./pool').closePool()
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}

module.exports = { migrate }
