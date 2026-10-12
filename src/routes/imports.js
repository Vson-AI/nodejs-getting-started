const express = require('express')
const multer = require('multer')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { getImportModule, IP_MODULES, DOCKET_MODULE } = require('../lib/modules')
const records = require('../lib/records')
const importer = require('../lib/importer')
const { writeAudit } = require('../lib/audit')
const { requireAuth, requireTenant, requirePermission } = require('../middleware/context')

const router = express.Router()
const UPLOAD_DIR = path.join(os.tmpdir(), 'ip-pms-imports')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

router.use(requireAuth, requireTenant)

const IMPORT_MODULES = [...Object.values(IP_MODULES), DOCKET_MODULE]

// ---------------------------------------------------------------------------
// Hub and history
// ---------------------------------------------------------------------------
router.get('/', requirePermission('import.run'), async (req, res, next) => {
  try {
    const jobs = res.locals.can('import.history')
      ? await req.db.all(
        `SELECT * FROM import_jobs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 8`,
        [req.user.tenantId])
      : []
    res.render('pages/import', {
      title: 'Import and export',
      activeNav: 'import',
      modules: IMPORT_MODULES,
      jobs
    })
  } catch (err) { next(err) }
})

router.get('/history', requirePermission('import.history'), async (req, res, next) => {
  try {
    const jobs = await req.db.all(
      'SELECT * FROM import_jobs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 200',
      [req.user.tenantId])
    res.render('pages/import-history', { title: 'Import history', activeNav: 'import', jobs })
  } catch (err) { next(err) }
})

router.get('/jobs/:id', requirePermission('import.history'), async (req, res, next) => {
  try {
    const job = await req.db.one(
      'SELECT * FROM import_jobs WHERE id = $1 AND tenant_id = $2',
      [Number(req.params.id), req.user.tenantId])
    if (!job) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown import job.' })
    const errors = await req.db.all(
      `SELECT row_number, column_name, error_message FROM import_job_errors
        WHERE import_job_id = $1 ORDER BY row_number, id LIMIT 200`,
      [job.id])
    const errorCount = Number(await req.db.value(
      'SELECT count(*) FROM import_job_errors WHERE import_job_id = $1', [job.id]))
    res.render('pages/import-job', {
      title: `Import job ${job.id}`,
      activeNav: 'import',
      job,
      errors,
      errorCount,
      mod: getImportModule(job.module)
    })
  } catch (err) { next(err) }
})

router.get('/jobs/:id/errors.csv', requirePermission('import.history'), async (req, res, next) => {
  try {
    const job = await req.db.one(
      'SELECT id FROM import_jobs WHERE id = $1 AND tenant_id = $2',
      [Number(req.params.id), req.user.tenantId])
    if (!job) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown import job.' })
    const csv = await importer.errorReportCsv(req.db, job.id)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="import_${job.id}_errors.csv"`)
    res.send(csv)
  } catch (err) { next(err) }
})

router.post('/jobs/:id/cancel', requirePermission('import.cancel'), async (req, res, next) => {
  try {
    const job = await req.db.one(
      'SELECT id, status FROM import_jobs WHERE id = $1 AND tenant_id = $2',
      [Number(req.params.id), req.user.tenantId])
    if (!job) return res.status(404).render('pages/error', { title: 'Not found', message: 'Unknown import job.' })
    if (job.status === 'RUNNING') {
      importer.requestCancel(job.id)
      req.flash('ok', 'Cancellation requested. The job stops at the next row or batch.')
    } else {
      req.flash('warn', 'That job has already finished.')
    }
    res.redirect(`/import/jobs/${job.id}`)
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------------------
// Per module
// ---------------------------------------------------------------------------
router.param('module', (req, res, next, slug) => {
  const mod = getImportModule(slug)
  if (!mod) {
    return res.status(404).render('pages/error', { title: 'Not found', message: `No module called "${slug}".` })
  }
  req.mod = mod
  res.locals.mod = mod
  next()
})

router.get('/:module', requirePermission('import.run'), async (req, res, next) => {
  try {
    const jobs = res.locals.can('import.history')
      ? await req.db.all(
        `SELECT * FROM import_jobs WHERE tenant_id = $1 AND module = $2
          ORDER BY started_at DESC LIMIT 10`,
        [req.user.tenantId, req.mod.slug])
      : []
    const settings = await req.db.one(
      'SELECT import_max_rows, import_max_bytes FROM tenant_settings WHERE tenant_id = $1',
      [req.user.tenantId])
    res.render('pages/import-module', {
      title: `Import ${req.mod.plural || req.mod.label}`,
      activeNav: 'import',
      jobs,
      settings: settings || { import_max_rows: 50000, import_max_bytes: 20971520 }
    })
  } catch (err) { next(err) }
})

/** Template download: blank, with sample row, or existing data (FR-IMP-003). */
router.get('/:module/template.csv', requirePermission('template.download'), async (req, res, next) => {
  try {
    const mod = req.mod
    const variant = ['blank', 'sample', 'data'].includes(req.query.variant) ? req.query.variant : 'blank'

    if (variant === 'data' && !res.locals.can('data.export')) {
      return res.status(403).render('pages/error', {
        title: 'Access denied', message: 'Your role may download blank templates but not existing data.'
      })
    }

    let rows = []
    if (variant === 'data') {
      const data = mod.slug === 'docket'
        ? await records.allDocket(req.db, req.user.tenantId, {})
        : await records.allRecords(req.db, mod, req.user.tenantId, {})
      rows = data.map((row) => importer.rowToCsv(mod, row))
    }

    const csv = importer.templateCsv(mod, variant === 'data' ? 'blank' : variant === 'sample' ? 'sample' : 'described', rows)
    await writeAudit(req.db, {
      tenantId: req.user.tenantId,
      clientId: req.user.clientId,
      username: req.user.username,
      action: variant === 'data' ? 'EXPORT' : 'TEMPLATE',
      module: mod.slug.toUpperCase(),
      newValue: { variant, rows: rows.length }
    })
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition',
      `attachment; filename="${importer.templateFileName(mod, req.user.tenantInitials)}"`)
    res.send(csv)
  } catch (err) { next(err) }
})

/** Upload with the tenant's own size limit applied (FR-IMP-017, NFR-026). */
async function uploadMiddleware (req, res, next) {
  try {
    const settings = await req.db.one(
      'SELECT import_max_bytes FROM tenant_settings WHERE tenant_id = $1', [req.user.tenantId])
    const maxBytes = settings ? Number(settings.import_max_bytes) : 20971520
    const upload = multer({
      storage: multer.diskStorage({
        destination: UPLOAD_DIR,
        filename: (r, file, cb) =>
          cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.csv`)
      }),
      limits: { fileSize: maxBytes, files: 1 }
    }).single('file')

    upload(req, res, (err) => {
      if (err) {
        req.flash('error', err.code === 'LIMIT_FILE_SIZE'
          ? `The file is larger than the ${Math.round(maxBytes / 1048576)} MB limit for this tenant.`
          : `Upload failed: ${err.message}`)
        return res.redirect(`/import/${req.params.module}`)
      }
      next()
    })
  } catch (err) { next(err) }
}

router.post('/:module', requirePermission('import.run'), uploadMiddleware, async (req, res, next) => {
  try {
    const mod = req.mod
    if (!req.file) {
      req.flash('error', 'Choose a CSV file to upload.')
      return res.redirect(`/import/${mod.slug}`)
    }

    const mode = req.body.mode === 'commit' ? 'COMMIT' : 'DRY_RUN'
    const skipInvalid = req.body.skip_invalid === 'on'

    const hash = crypto.createHash('sha256')
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(req.file.path)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', resolve)
      stream.on('error', reject)
    })
    const fileHash = hash.digest('hex')

    const job = await req.db.one(
      `INSERT INTO import_jobs (tenant_id, user_id, username, module, file_name, file_hash,
                                file_path, mode, skip_invalid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.user.tenantId, req.user.id, req.user.username, mod.slug,
        req.file.originalname, fileHash, req.file.path, mode, skipInvalid]
    )

    await writeAudit(req.db, {
      tenantId: req.user.tenantId,
      username: req.user.username,
      action: mode === 'COMMIT' ? 'IMPORT_START' : 'VALIDATE',
      module: mod.slug.toUpperCase(),
      recordId: Number(job.id),
      newValue: { file_name: req.file.originalname, file_hash: fileHash, mode, skip_invalid: skipInvalid }
    })

    // Runs in the background so the browser can poll progress and cancel.
    importer.runJob(Number(job.id), {
      tenantId: req.user.tenantId,
      clientId: null,
      userType: 'STAFF',
      username: req.user.username
    })

    res.redirect(`/import/jobs/${job.id}`)
  } catch (err) { next(err) }
})

module.exports = router
