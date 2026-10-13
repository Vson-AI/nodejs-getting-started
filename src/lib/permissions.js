/**
 * Role to permission matrix (SRS section 11).
 * Every route guard and every UI affordance reads from this one table.
 */
const MATRIX = {
  'tenant.manage': ['PLATFORM_ADMIN'],
  'tenant.rename_initials': ['ADMIN'],
  'user.manage': ['ADMIN'],
  'client.manage': ['ADMIN'],
  'client_account.manage': ['ADMIN'],
  'settings.manage': ['ADMIN'],
  'data.view': ['ADMIN', 'EXAMINER', 'VIEWER', 'CLIENT', 'AUDITOR'],
  'ip.create': ['ADMIN', 'EXAMINER'],
  'ip.update': ['ADMIN', 'EXAMINER'],
  'ip.delete': ['ADMIN'],
  'ip.assign_client': ['ADMIN', 'EXAMINER'],
  'docket.write': ['ADMIN', 'EXAMINER'],
  'docket.delete': ['ADMIN'],
  'audit.view': ['ADMIN', 'EXAMINER', 'VIEWER', 'AUDITOR'],
  'audit.export': ['ADMIN', 'EXAMINER'],
  'reports.run': ['ADMIN', 'EXAMINER', 'VIEWER', 'CLIENT'],
  'data.export': ['ADMIN', 'EXAMINER', 'CLIENT'],
  'template.download': ['ADMIN', 'EXAMINER', 'VIEWER', 'CLIENT'],
  'import.run': ['ADMIN', 'EXAMINER'],
  'import.cancel': ['ADMIN'],
  'import.history': ['ADMIN', 'EXAMINER']
}

function can (user, permission) {
  if (!user) return false
  const allowed = MATRIX[permission]
  if (!allowed) return false
  return (user.roles || []).some((role) => allowed.includes(role))
}

/** Client portal users are read-only everywhere (BR-22). */
function isClient (user) {
  return !!user && user.userType === 'CLIENT'
}

function isPlatformAdmin (user) {
  return !!user && user.userType === 'PLATFORM_ADMIN'
}

module.exports = { MATRIX, can, isClient, isPlatformAdmin }
