const { withSystemContext } = require('../db/pool')

/**
 * Audit archiving (FR-AUD-006 to 008, NFR-010).
 * The SRS schedules this as a monthly SQL Agent job. Here the application
 * holds the schedule: it checks daily and archives when the last run was more
 * than 28 days ago. The job writes its own audit entry.
 */
const RETENTION_YEARS = Number(process.env.AUDIT_RETENTION_YEARS || 5)
const DAY_MS = 24 * 60 * 60 * 1000

async function lastRun (db) {
  return db.value(
    `SELECT max(created_at) FROM audit_logs
      WHERE module = 'AUDIT' AND action = 'ARCHIVE'`
  )
}

async function runArchive (years = RETENTION_YEARS) {
  return withSystemContext(async (db) => {
    const moved = await db.value('SELECT app_archive_audit_logs($1)', [years])
    return Number(moved)
  })
}

async function runIfDue () {
  return withSystemContext(async (db) => {
    const last = await lastRun(db)
    if (last && Date.now() - new Date(last).getTime() < 28 * DAY_MS) return null
    const moved = await db.value('SELECT app_archive_audit_logs($1)', [RETENTION_YEARS])
    console.log(`[archive] moved ${moved} audit row(s) older than ${RETENTION_YEARS} years`)
    return Number(moved)
  })
}

let timer = null

function startScheduler () {
  if (timer) return
  // First check a minute after boot, then once a day.
  setTimeout(() => { runIfDue().catch((e) => console.error('[archive]', e.message)) }, 60000).unref()
  timer = setInterval(() => {
    runIfDue().catch((e) => console.error('[archive]', e.message))
  }, DAY_MS)
  timer.unref()
}

function stopScheduler () {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = { runArchive, runIfDue, startScheduler, stopScheduler, lastRun, RETENTION_YEARS }
