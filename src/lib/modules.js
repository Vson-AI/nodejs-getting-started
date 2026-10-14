/**
 * Module registry.
 *
 * One declaration per IP module (plus the docket) drives the list grids, the
 * create/edit forms, the CSV templates of SRS section 14, the import
 * validators and the exports. Adding a column in one place updates all of them,
 * which is what BR-31 ("templates must always match the schema of the current
 * release") requires.
 *
 * Field types:
 *   text | textarea | date | select | int | classes | countries | client | bool
 */

const STATUS_LISTS = {
  patent: ['Pending', 'Published', 'Granted', 'Lapsed', 'Expired', 'Abandoned'],
  utility_model: ['Pending', 'Granted', 'Lapsed', 'Expired', 'Abandoned'],
  trademark: ['Pending', 'Published', 'Registered', 'Opposed', 'Expired', 'Cancelled'],
  copyright: ['Pending', 'Registered', 'Expired'],
  design: ['Pending', 'Registered', 'Expired', 'Cancelled'],
  docket: ['Open', 'In Progress', 'Awaiting Client', 'Filed', 'Completed', 'Cancelled']
}

const PRIORITIES = ['Low', 'Medium', 'High']

const f = (name, label, type, opts = {}) => ({
  name,
  label,
  type,
  required: false,
  csv: true,
  list: false,
  ...opts
})

const IP_MODULES = {
  patents: {
    slug: 'patents',
    table: 'patents',
    ipType: 'patent',
    typeCode: 'P',
    label: 'Patent',
    plural: 'Patents',
    icon: 'P',
    statusKey: 'patent',
    fields: [
      f('title', 'Title', 'text', { required: true, max: 500, list: true }),
      f('status', 'Status', 'select', { required: true, list: true }),
      f('filing_date', 'Filing date', 'date', { required: true, list: true }),
      f('publication_date', 'Publication date', 'date'),
      f('grant_date', 'Grant date', 'date'),
      f('expiry_date', 'Expiry date', 'date', { list: true }),
      f('owner', 'Owner', 'text', { max: 255, list: true }),
      f('inventors', 'Inventors', 'text', { max: 1000, help: 'Separate multiple inventors with ;' }),
      f('applicant', 'Applicant', 'text', { max: 255 }),
      f('ipc_class', 'IPC class', 'text', { max: 100 }),
      f('abstract', 'Abstract', 'textarea')
    ],
    searchFields: ['title', 'owner', 'applicant', 'three_eyes_ref'],
    sample: {
      title: 'Solar powered water purifier',
      status: 'Pending',
      filing_date: '2025-03-14',
      publication_date: '',
      grant_date: '',
      expiry_date: '2045-03-14',
      owner: 'Helio Labs Ltd',
      inventors: 'T Moyo;R Banda',
      applicant: 'Helio Labs Ltd',
      ipc_class: 'C02F 1/14',
      abstract: 'A portable purifier that uses concentrated solar heat.'
    }
  },

  'utility-models': {
    slug: 'utility-models',
    table: 'utility_models',
    ipType: 'utility_model',
    typeCode: 'U',
    label: 'Utility model',
    plural: 'Utility Models',
    icon: 'U',
    statusKey: 'utility_model',
    fields: [
      f('title', 'Title', 'text', { required: true, max: 500, list: true }),
      f('status', 'Status', 'select', { required: true, list: true }),
      f('filing_date', 'Filing date', 'date', { required: true, list: true }),
      f('grant_date', 'Grant date', 'date'),
      f('expiry_date', 'Expiry date', 'date', { list: true }),
      f('owner', 'Owner', 'text', { max: 255, list: true }),
      f('inventors', 'Inventors', 'text', { max: 1000, help: 'Separate multiple inventors with ;' }),
      f('applicant', 'Applicant', 'text', { max: 255 }),
      f('ipc_class', 'IPC class', 'text', { max: 100 }),
      f('abstract', 'Abstract', 'textarea')
    ],
    searchFields: ['title', 'owner', 'applicant', 'three_eyes_ref'],
    sample: {
      title: 'Clip-on bicycle cargo rack',
      status: 'Pending',
      filing_date: '2025-05-02',
      grant_date: '',
      expiry_date: '2035-05-02',
      owner: 'Chikwava Works',
      inventors: 'L Chikwava',
      applicant: 'Chikwava Works',
      ipc_class: 'B62J 7/04',
      abstract: 'A rack that clamps to a seat post without tools.'
    }
  },

  trademarks: {
    slug: 'trademarks',
    table: 'trademarks',
    ipType: 'trademark',
    typeCode: 'M',
    label: 'Trademark',
    plural: 'Trademarks',
    icon: 'M',
    statusKey: 'trademark',
    fields: [
      f('title', 'Mark', 'text', { required: true, max: 500, list: true }),
      f('ipo_ref', 'IPO reference', 'text', { max: 100 }),
      f('classes', 'Nice classes', 'classes', { help: 'Classes 1 to 45, separated with ;', list: true }),
      f('class_description', 'Class description', 'textarea'),
      f('registration_number', 'Registration number', 'text', { max: 100, list: true }),
      f('applicant', 'Applicant', 'text', { max: 255, list: true }),
      f('territory', 'Territory', 'text', { max: 100 }),
      f('designated_states', 'Designated states', 'countries', { help: 'Country names separated with ;' }),
      f('filing_date', 'Filing date', 'date', { required: true, list: true }),
      f('expiry_date', 'Expiry date', 'date', { list: true }),
      f('status', 'Status', 'select', { required: true, list: true })
    ],
    searchFields: ['title', 'applicant', 'registration_number', 'territory', 'three_eyes_ref'],
    sample: {
      title: 'KOPJE',
      ipo_ref: 'IPO/2025/4412',
      classes: '9;35;42',
      class_description: 'Software; retail services; design services',
      registration_number: 'TM-2025-0091',
      applicant: 'Kopje Holdings',
      territory: 'Zimbabwe',
      designated_states: 'Zimbabwe;South Africa;Botswana',
      filing_date: '2025-01-20',
      expiry_date: '2035-01-20',
      status: 'Pending'
    }
  },

  copyrights: {
    slug: 'copyrights',
    table: 'copyrights',
    ipType: 'copyright',
    typeCode: 'C',
    label: 'Copyright',
    plural: 'Copyrights',
    icon: 'C',
    statusKey: 'copyright',
    fields: [
      f('title', 'Title', 'text', { required: true, max: 500, list: true }),
      f('work_type', 'Work type', 'text', { max: 100, list: true }),
      f('author', 'Author', 'text', { max: 255, list: true }),
      f('registration_number', 'Registration number', 'text', { max: 100 }),
      f('filing_date', 'Filing date', 'date', { required: true, list: true }),
      f('expiry_date', 'Expiry date', 'date', { list: true }),
      f('status', 'Status', 'select', { required: true, list: true })
    ],
    searchFields: ['title', 'author', 'registration_number', 'three_eyes_ref'],
    sample: {
      title: 'Harvest Songs, volume two',
      work_type: 'Musical work',
      author: 'N Dube',
      registration_number: 'CR-2025-0007',
      filing_date: '2025-02-11',
      expiry_date: '2095-02-11',
      status: 'Registered'
    }
  },

  designs: {
    slug: 'designs',
    table: 'industrial_designs',
    ipType: 'design',
    typeCode: 'D',
    label: 'Industrial design',
    plural: 'Industrial Designs',
    icon: 'D',
    statusKey: 'design',
    fields: [
      f('title', 'Title', 'text', { required: true, max: 500, list: true }),
      f('locarno_class', 'Locarno class', 'text', { max: 100, list: true }),
      f('registration_number', 'Registration number', 'text', { max: 100 }),
      f('applicant', 'Applicant', 'text', { max: 255, list: true }),
      f('filing_date', 'Filing date', 'date', { required: true, list: true }),
      f('expiry_date', 'Expiry date', 'date', { list: true }),
      f('status', 'Status', 'select', { required: true, list: true })
    ],
    searchFields: ['title', 'applicant', 'registration_number', 'three_eyes_ref'],
    sample: {
      title: 'Stackable water container',
      locarno_class: '09-01',
      registration_number: 'ID-2025-0033',
      applicant: 'Kopje Holdings',
      filing_date: '2025-04-08',
      expiry_date: '2040-04-08',
      status: 'Pending'
    }
  }
}

const DOCKET_MODULE = {
  slug: 'docket',
  table: 'docket_entries',
  label: 'Docket entry',
  plural: 'Docket',
  statusKey: 'docket',
  fields: [
    f('ip_type', 'Linked IP type', 'select', {
      options: ['patent', 'utility_model', 'trademark', 'copyright', 'design']
    }),
    f('ip_record_ref', 'Linked IP reference', 'text', { max: 60, list: true }),
    f('title', 'Title', 'text', { required: true, max: 500, list: true }),
    f('description', 'Description', 'textarea'),
    f('due_date', 'Due date', 'date', { required: true, list: true }),
    f('assigned_to', 'Assigned to', 'text', { max: 100, list: true }),
    f('status', 'Status', 'select'),
    f('status_date', 'Status date', 'date'),
    f('action_due', 'Action due', 'text', { max: 255 }),
    f('action_due_date', 'Action due date', 'date'),
    f('priority', 'Priority', 'select', { options: PRIORITIES, list: true }),
    f('comments', 'Comments', 'textarea'),
    f('documents', 'Documents', 'files', { help: 'Local paths or URLs separated with ;' }),
    f('reproduction', 'Reproduction', 'file'),
    f('certificate', 'Certificate', 'file')
  ],
  searchFields: ['title', 'assigned_to', 'ip_record_ref'],
  sample: {
    ip_type: 'trademark',
    ip_record_ref: 'ABC/M/2025/000001',
    title: 'File response to examination report',
    description: 'Office action issued 2025-06-02.',
    due_date: '2025-09-01',
    assigned_to: 'examiner',
    status: 'Open',
    status_date: '2025-06-03',
    action_due: 'Response filing',
    action_due_date: '2025-08-25',
    priority: 'High',
    comments: '',
    documents: 'C:\\IP\\ABC\\office-action.pdf;https://files.example.com/oa-2025.pdf',
    reproduction: '',
    certificate: ''
  }
}

const IP_TYPE_TO_SLUG = Object.fromEntries(
  Object.values(IP_MODULES).map((m) => [m.ipType, m.slug])
)

const TABLE_TO_MODULE = Object.fromEntries(
  Object.values(IP_MODULES).map((m) => [m.table, m])
)

const AUDIT_MODULE_BY_IP_TYPE = {
  patent: 'PATENT',
  utility_model: 'UTILITY_MODEL',
  trademark: 'TRADEMARK',
  copyright: 'COPYRIGHT',
  design: 'DESIGN'
}

function getModule (slug) {
  return IP_MODULES[slug] || null
}

function getImportModule (slug) {
  if (slug === 'docket') return DOCKET_MODULE
  return IP_MODULES[slug] || null
}

/** CSV header row for a module, per SRS section 14.2. */
function csvColumns (mod) {
  const base = ['action', 'existing_reference']
  const own = mod.fields.filter((x) => x.csv).map((x) => x.name)
  return [...base, ...own, 'client_code', 'created_by']
}

const COLUMN_DESCRIPTIONS = {
  action: 'CREATE or UPDATE',
  existing_reference: 'Required when action=UPDATE; the current reference',
  client_code: 'Client code in this tenant; leave blank for none',
  created_by: 'Informational only; ignored on import'
}

function csvDescriptions (mod) {
  return csvColumns(mod).map((col) => {
    if (COLUMN_DESCRIPTIONS[col]) return COLUMN_DESCRIPTIONS[col]
    const field = mod.fields.find((x) => x.name === col)
    if (!field) return ''
    const bits = []
    bits.push(field.label)
    if (field.required) bits.push('required')
    if (field.type === 'date') bits.push('yyyy-MM-dd')
    if (field.type === 'classes') bits.push('1-45 separated with ;')
    if (field.type === 'countries') bits.push('country names separated with ;')
    if (field.type === 'select') bits.push('controlled list')
    return bits.join('; ')
  })
}

function sampleRow (mod) {
  const cols = csvColumns(mod)
  const sample = mod.sample || {}
  return cols.map((col) => {
    if (col === 'action') return 'CREATE'
    if (col === 'existing_reference') return ''
    if (col === 'client_code') return 'ACME'
    if (col === 'created_by') return ''
    return sample[col] == null ? '' : String(sample[col])
  })
}

module.exports = {
  IP_MODULES,
  DOCKET_MODULE,
  STATUS_LISTS,
  PRIORITIES,
  IP_TYPE_TO_SLUG,
  TABLE_TO_MODULE,
  AUDIT_MODULE_BY_IP_TYPE,
  getModule,
  getImportModule,
  csvColumns,
  csvDescriptions,
  sampleRow
}
