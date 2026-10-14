/**
 * RFC 4180 CSV reading and writing (SRS section 14.1).
 * UTF-8, comma delimited, double-quote quoting, CRLF line endings on output.
 * The parser is incremental so a 50 000 row upload is never held in memory
 * as a whole (NFR-023).
 */

function quoteCell (value) {
  if (value == null) return ''
  const text = String(value)
  if (text === '') return ''
  if (/[",\r\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"'
  }
  return text
}

function formatRow (cells) {
  return cells.map(quoteCell).join(',')
}

/** Serialise an array of arrays into a CSV document. */
function formatCsv (rows) {
  return rows.map(formatRow).join('\r\n') + '\r\n'
}

class CsvStreamParser {
  /**
   * @param {(cells: string[], rowNumber: number) => void} onRow
   *        rowNumber is 1-based and counts physical records, header included.
   */
  constructor (onRow) {
    this.onRow = onRow
    this.field = ''
    this.row = []
    this.inQuotes = false
    this.pendingQuote = false
    this.rowNumber = 0
    this.rowHasContent = false
    this.firstChunk = true
  }

  push (text) {
    let chunk = String(text)
    if (this.firstChunk) {
      this.firstChunk = false
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1) // strip BOM
    }
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]
      if (this.inQuotes) {
        if (this.pendingQuote) {
          this.pendingQuote = false
          if (c === '"') {
            this.field += '"'
            continue
          }
          this.inQuotes = false
          i -= 1 // re-read this character outside quotes
          continue
        }
        if (c === '"') {
          this.pendingQuote = true
        } else {
          this.field += c
        }
        continue
      }
      if (c === '"' && this.field === '') {
        this.inQuotes = true
        this.rowHasContent = true
      } else if (c === ',') {
        this.row.push(this.field)
        this.field = ''
        this.rowHasContent = true
      } else if (c === '\n') {
        this._emit()
      } else if (c === '\r') {
        // part of CRLF; ignored
      } else {
        this.field += c
        this.rowHasContent = true
      }
    }
  }

  _emit () {
    this.row.push(this.field)
    this.field = ''
    const cells = this.row
    this.row = []
    const hadContent = this.rowHasContent
    this.rowHasContent = false
    if (!hadContent && cells.length === 1 && cells[0] === '') return // blank line
    this.rowNumber += 1
    this.onRow(cells, this.rowNumber)
  }

  end () {
    if (this.pendingQuote) {
      this.pendingQuote = false
      this.inQuotes = false
    }
    if (this.rowHasContent || this.row.length > 0 || this.field !== '') {
      this._emit()
    }
  }
}

/** Convenience wrapper used by tests and small in-memory documents. */
function parseCsv (text) {
  const rows = []
  const parser = new CsvStreamParser((cells) => rows.push(cells))
  parser.push(text)
  parser.end()
  return rows
}

/** Split a semicolon-separated multi-value cell (SRS section 14.1). */
function splitMulti (value) {
  if (value == null) return []
  return String(value)
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function joinMulti (values) {
  if (!values) return ''
  return values.join(';')
}

module.exports = {
  quoteCell,
  formatRow,
  formatCsv,
  parseCsv,
  CsvStreamParser,
  splitMulti,
  joinMulti
}
