const { Pool } = require('pg')

// One shared pool for the whole process.
let pool = null
function getPool () {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set')
    }
    pool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX || 8),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: /sslmode=(require|prefer|verify)/.test(connectionString)
        ? { rejectUnauthorized: false }
        : undefined
    })
    pool.on('error', (err) => console.error('[db] idle client error', err.message))
  }
  return pool
}

const EMPTY_CONTEXT = {
  tenantId: null,
  clientId: null,
  userType: 'NONE',
  username: 'anonymous',
  bypass: false
}

/**
 * A database session carrying the RLS context of SRS section 9.1.
 * The client is acquired lazily on first query and held for the lifetime of
 * the request (or job), so every statement runs under the same context.
 */
class DbContext {
  constructor (context = {}) {
    this.context = { ...EMPTY_CONTEXT, ...context }
    this._client = null
    this._released = false
    this._inTx = false
  }

  async _acquire () {
    if (this._client) return this._client
    const client = await getPool().connect()
    this._client = client
    const c = this.context
    await client.query(
      `SELECT set_config('app.tenant_id', $1, false),
              set_config('app.client_id', $2, false),
              set_config('app.user_type', $3, false),
              set_config('app.username',  $4, false),
              set_config('app.bypass',    $5, false)`,
      [
        c.tenantId == null ? '' : String(c.tenantId),
        c.clientId == null ? '' : String(c.clientId),
        c.userType || 'NONE',
        c.username || 'anonymous',
        c.bypass ? 'on' : 'off'
      ]
    )
    return client
  }

  /**
   * Adopt a new RLS context. Called once the signed-in user has been loaded,
   * so that every statement after it runs as that user.
   */
  async setContext (context) {
    this.context = { ...this.context, ...context }
    if (!this._client) return
    const c = this.context
    await this._client.query(
      `SELECT set_config('app.tenant_id', $1, false),
              set_config('app.client_id', $2, false),
              set_config('app.user_type', $3, false),
              set_config('app.username',  $4, false)`,
      [
        c.tenantId == null ? '' : String(c.tenantId),
        c.clientId == null ? '' : String(c.clientId),
        c.userType || 'NONE',
        c.username || 'anonymous'
      ]
    )
  }

  async query (text, params) {
    const client = await this._acquire()
    return client.query(text, params)
  }

  /** First row, or null. */
  async one (text, params) {
    const { rows } = await this.query(text, params)
    return rows[0] || null
  }

  /** All rows. */
  async all (text, params) {
    const { rows } = await this.query(text, params)
    return rows
  }

  /** Scalar of the first column of the first row. */
  async value (text, params) {
    const row = await this.one(text, params)
    if (!row) return null
    return row[Object.keys(row)[0]]
  }

  async begin () {
    await this.query('BEGIN')
    this._inTx = true
  }

  async commit () {
    await this.query('COMMIT')
    this._inTx = false
  }

  async rollback () {
    try { await this.query('ROLLBACK') } catch { /* connection already gone */ }
    this._inTx = false
  }

  /** Run fn inside a transaction, rolling back on any error. */
  async tx (fn) {
    await this.begin()
    try {
      const result = await fn(this)
      await this.commit()
      return result
    } catch (err) {
      await this.rollback()
      throw err
    }
  }

  async release () {
    if (this._released || !this._client) {
      this._released = true
      return
    }
    this._released = true
    const client = this._client
    this._client = null
    try {
      if (this._inTx) await client.query('ROLLBACK')
      await client.query(
        `SELECT set_config('app.tenant_id', '', false),
                set_config('app.client_id', '', false),
                set_config('app.user_type', 'NONE', false),
                set_config('app.username',  'anonymous', false),
                set_config('app.bypass',    'off', false)`
      )
      client.release()
    } catch (err) {
      client.release(err)
    }
  }
}

/** Run a unit of work with an explicit RLS context. */
async function withContext (context, fn) {
  const db = new DbContext(context)
  try {
    return await fn(db)
  } finally {
    await db.release()
  }
}

/** Maintenance context: bypasses RLS. Migrations, seeding, archive job only. */
async function withSystemContext (fn) {
  return withContext(
    { userType: 'PLATFORM_ADMIN', username: 'system', bypass: true },
    fn
  )
}

async function closePool () {
  if (pool) {
    await pool.end()
    pool = null
  }
}

module.exports = { getPool, DbContext, withContext, withSystemContext, closePool }
