const { pathType } = require('./validate')

/** Formatting helpers shared by every template. */

function d (value) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  return new Date(value).toISOString().slice(0, 10)
}

function dt (value) {
  if (!value) return ''
  const date = new Date(value)
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`
}

function daysUntil (value) {
  if (!value) return null
  const target = new Date(d(value) + 'T00:00:00Z').getTime()
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
  return Math.round((target - today) / 86400000)
}

const GOOD = ['granted', 'registered', 'active', 'completed', 'published']
const WARN = ['pending', 'in progress', 'awaiting client', 'opposed', 'filed', 'suspended', 'dry_run', 'running']
const BAD = ['expired', 'lapsed', 'abandoned', 'cancelled', 'failed', 'inactive', 'deleted']

function statusClass (value) {
  const text = String(value || '').toLowerCase()
  if (GOOD.includes(text)) return 'ok'
  if (WARN.includes(text)) return 'warn'
  if (BAD.includes(text)) return 'bad'
  return ''
}

function priorityClass (value) {
  const text = String(value || '').toLowerCase()
  if (text === 'high') return 'bad'
  if (text === 'medium') return 'warn'
  return ''
}

/** Rebuild the current query string with overrides, for filters and paging. */
function qs (query, overrides = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...query, ...overrides })) {
    if (value === null || value === undefined || value === '') continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? '?' + text : ''
}

function listValue (value) {
  if (value == null) return ''
  if (Array.isArray(value)) return value.join('; ')
  return String(value)
}

function fileLinks (value) {
  if (!value) return []
  return String(value)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ path: part, type: pathType(part) }))
}

function number (value) {
  return Number(value || 0).toLocaleString('en-GB')
}

module.exports = { d, dt, daysUntil, statusClass, priorityClass, qs, listValue, fileLinks, number }
