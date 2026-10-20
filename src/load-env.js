const fs = require('fs')
const path = require('path')

/**
 * Minimal .env reader for command line scripts. The running app gets its
 * environment from the platform, so values already set are never overwritten.
 */
function loadEnv (file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const index = text.indexOf('=')
    if (index < 1) continue
    const key = text.slice(0, index).trim()
    let value = text.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

module.exports = { loadEnv }
