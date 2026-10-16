const { splitMulti } = require('./csv')

/**
 * Field validation shared by the web forms and the CSV importer, so an
 * imported row is held to exactly the same rules as a typed one
 * (SRS sections 14.9 and 12).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidDate (text) {
  if (!DATE_RE.test(text)) return false
  const [y, m, d] = text.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

function isUrl (text) {
  return /^(https?|ftp):\/\/\S+$/i.test(text)
}

function isLocalPath (text) {
  return /^([a-zA-Z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|file:\/\/)/.test(text)
}

/** Path type detection by prefix (FR-FIL-004). */
function pathType (text) {
  if (!text) return null
  if (isUrl(text)) return 'url'
  return 'local'
}

const trim = (v) => (v == null ? '' : String(v).trim())

/**
 * @param {object} mod     module definition from modules.js
 * @param {object} raw     plain object of submitted values keyed by column
 * @param {object} lookups { statuses, countryByName, countryByCode, clientCodes, usernames }
 * @returns {{ values: object, errors: Array<{column: string, message: string}> }}
 */
function validateRecord (mod, raw, lookups = {}) {
  const errors = []
  const values = {}
  const statuses = lookups.statuses || []
  const add = (column, message) => errors.push({ column, message })

  for (const field of mod.fields) {
    const input = trim(raw[field.name])

    if (field.required && input === '') {
      add(field.name, `${field.label} is required`)
      values[field.name] = null
      continue
    }

    if (input === '') {
      values[field.name] = field.name === 'classes' || field.name === 'designated_states' ? [] : null
      if (field.name === 'classes' && mod.slug === 'trademarks') {
        add('classes', 'At least one Nice class is required')
      }
      continue
    }

    switch (field.type) {
      case 'date': {
        if (!isValidDate(input)) {
          add(field.name, `${field.label} must be a date in yyyy-MM-dd format`)
          values[field.name] = null
        } else {
          values[field.name] = input
        }
        break
      }
      case 'select': {
        const options = field.options || statuses
        const match = options.find((o) => o.toLowerCase() === input.toLowerCase())
        if (!match) {
          add(field.name, `${field.label} must be one of: ${options.join(', ')}`)
          values[field.name] = null
        } else {
          values[field.name] = match
        }
        break
      }
      case 'classes': {
        const parts = splitMulti(input)
        const classes = []
        for (const part of parts) {
          const n = Number(part)
          if (!Number.isInteger(n) || n < 1 || n > 45) {
            add('classes', `Class "${part}" is not a whole number between 1 and 45`)
          } else if (!classes.includes(n)) {
            classes.push(n)
          }
        }
        if (classes.length === 0 && errors.every((e) => e.column !== 'classes')) {
          add('classes', 'At least one Nice class is required')
        }
        values.classes = classes.sort((a, b) => a - b)
        break
      }
      case 'countries': {
        const parts = splitMulti(input)
        const codes = []
        for (const part of parts) {
          const byCode = lookups.countryByCode && lookups.countryByCode.get(part.toUpperCase())
          const byName = lookups.countryByName && lookups.countryByName.get(part.toLowerCase())
          const code = byCode ? byCode.code : byName ? byName.code : null
          if (!code) {
            add('designated_states', `Country "${part}" is not in the country list`)
          } else if (!codes.includes(code)) {
            codes.push(code)
          }
        }
        values.designated_states = codes
        break
      }
      case 'files':
      case 'file': {
        const parts = field.type === 'files' ? splitMulti(input) : [input]
        for (const part of parts) {
          if (!isUrl(part) && !isLocalPath(part) && !/^[\w .\-()]+\.[A-Za-z0-9]{1,8}$/.test(part)) {
            add(field.name, `"${part}" is not a recognised file path or URL`)
          }
        }
        values[field.name] = field.type === 'files' ? parts.join(';') : input
        break
      }
      case 'int': {
        const n = Number(input)
        if (!Number.isInteger(n)) {
          add(field.name, `${field.label} must be a whole number`)
        }
        values[field.name] = Number.isInteger(n) ? n : null
        break
      }
      default: {
        if (field.max && input.length > field.max) {
          add(field.name, `${field.label} must be ${field.max} characters or fewer`)
          values[field.name] = input.slice(0, field.max)
        } else {
          values[field.name] = input
        }
      }
    }
  }

  // BR-11 expiry must be later than filing
  if (values.filing_date && values.expiry_date && values.expiry_date <= values.filing_date) {
    add('expiry_date', 'Expiry date must be later than the filing date')
  }

  // Docket specific cross-field rules
  if (mod.slug === 'docket') {
    if (values.ip_type && !trim(raw.ip_record_ref)) {
      add('ip_record_ref', 'Linked IP reference is required when an IP type is given')
    }
    if (!values.ip_type && trim(raw.ip_record_ref)) {
      add('ip_type', 'Linked IP type is required when an IP reference is given')
    }
    if (!values.priority) values.priority = 'Medium'
  }

  // Client code resolution (shared by form and import)
  const clientCode = trim(raw.client_code)
  if (clientCode !== '') {
    const client = lookups.clientCodes && lookups.clientCodes.get(clientCode.toUpperCase())
    if (!client) {
      add('client_code', `Client code "${clientCode}" does not exist in this tenant`)
    } else {
      values.client_id = client.id
    }
  } else if (Object.prototype.hasOwnProperty.call(raw, 'client_id')) {
    const id = trim(raw.client_id)
    values.client_id = id === '' ? null : Number(id)
  } else if (Object.prototype.hasOwnProperty.call(raw, 'client_code')) {
    values.client_id = null
  }

  if (values.assigned_to && lookups.usernames && lookups.usernames.size > 0) {
    if (!lookups.usernames.has(String(values.assigned_to).toLowerCase())) {
      add('assigned_to', `"${values.assigned_to}" is not a username in this tenant`)
    }
  }

  return { values, errors }
}

/** Password policy (FR-AUTH-007). */
function validatePassword (password) {
  const text = String(password || '')
  if (text.length < 8) return 'Password must be at least 8 characters'
  if (!/[A-Za-z]/.test(text) || !/\d/.test(text)) {
    return 'Password must contain at least one letter and one digit'
  }
  return null
}

/** Tenant initials rule (R-01, BR-19). */
function validateInitials (value) {
  const text = trim(value).toUpperCase()
  if (!/^[A-Z0-9]{2,8}$/.test(text)) {
    return { value: text, error: 'Initials must be 2 to 8 uppercase letters or digits' }
  }
  return { value: text, error: null }
}

module.exports = {
  isValidDate,
  isUrl,
  isLocalPath,
  pathType,
  validateRecord,
  validatePassword,
  validateInitials
}
