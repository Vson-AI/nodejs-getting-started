const nodemailer = require('nodemailer')
const { decrypt } = require('./crypto')

/**
 * Per-tenant SMTP (SRS section 6.11). Phase 1 ships the configuration screen
 * and the test send; scheduled expiry notifications are Phase 2 (FR-CFG-004).
 */
async function loadTransport (db, tenantId) {
  const settings = await db.one(
    `SELECT smtp_host, smtp_port, smtp_user, smtp_password_encrypted,
            smtp_from, smtp_use_tls, smtp_enabled
       FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId]
  )
  if (!settings || !settings.smtp_host) {
    throw new Error('No SMTP host is configured for this tenant')
  }
  if (!settings.smtp_enabled) {
    throw new Error('SMTP is configured but not enabled')
  }
  const password = settings.smtp_password_encrypted
    ? decrypt(settings.smtp_password_encrypted)
    : null

  const transport = nodemailer.createTransport({
    host: settings.smtp_host,
    port: settings.smtp_port || 587,
    secure: Number(settings.smtp_port) === 465,
    requireTLS: !!settings.smtp_use_tls,
    auth: settings.smtp_user ? { user: settings.smtp_user, pass: password || '' } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000
  })
  return { transport, from: settings.smtp_from || settings.smtp_user }
}

async function sendTestEmail (db, tenantId, to, tenantName) {
  const { transport, from } = await loadTransport(db, tenantId)
  await transport.sendMail({
    from,
    to,
    subject: `IP-PMS test message for ${tenantName}`,
    text: [
      `This is a test message from the IP-PMS mail settings of ${tenantName}.`,
      'If you received it, outgoing mail works.',
      `Sent ${new Date().toISOString()}`
    ].join('\n')
  })
}

module.exports = { loadTransport, sendTestEmail }
