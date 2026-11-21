// A faster drop-in for csv-reader 1.0.0: returns exactly what csv-reader
// returns for {text, header} — {columns, rows, errors} — but scans with
// native indexOf searches and sliced fields instead of the reference's
// character-at-a-time loop with string concatenation.
//
// Semantics (csv-reader 1.0.0, make.fun's own policy):
//  - a U+FEFF at the very start is dropped;
//  - a record ends at LF or CRLF, and a line left with no characters is no record;
//  - outside quotes a CR not followed by LF is dropped (error stray_cr);
//  - a field that opens with a quote runs to the next quote that is not doubled,
//    "" inside it one quote, each CRLF or lone CR inside it read as LF; what
//    follows its closing quote, up to the next comma or line break, is appended
//    as it stands (quote_junk, when the field ends); a quote that never closes
//    is a literal character, and the text after it is read again as unquoted
//    (unterminated_quote);
//  - a quote inside an unquoted field is a literal character; fields stay
//    strings, never trimmed or converted;
//  - columns is the first record when header is true, else null; rows holds the
//    records after it, each padded (short_row, with fields: its field count) or
//    cut (long_row, with extra: the cut fields) to the first record's width;
//  - each error is {code, line, row}, in the order met; line the 1-based line
//    its record starts on, row its record's index in rows (null for the header).
//
// Speed: unquoted fields are found with two indexOf scans (',' and '\n') plus
// a monotone CR cursor — the position of the next '\r' at or after pos,
// advanced lazily, so every '\r' is found by one forward scan in total and a
// stray CR is detected with an O(1) comparison instead of an unbounded scan.
// Whole clean lines (no quote, no stray CR) parse with one native split(',').
// The unquoted scan is inlined in the field loop: no per-field call.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

// How a field ended: at a comma (record goes on), at a line break or at the
// end of the text (record ends).
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The CR cursor: the first '\r' at or after pos, or n when there is none.
  // Advanced lazily; every '\r' is found by one forward scan in total.
  let nextCR = text.indexOf('\r', 0);
  if (nextCR === -1) nextCR = n;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const ch = text.charCodeAt(pos);
      if (ch === 10) {
        pos += 1;
        line += 1;
      } else if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let quoted = false;

    // Fast path: a line with no quote and no stray CR parses with one native
    // split(','). A line whose first field opens with a quote is never clean,
    // so it skips this check outright. Otherwise look for a quote: one
    // indexOf that stops at the first quote (usually inside this line). Only
    // when the line is quote-free do the CR check, via the cursor: clean when
    // no '\r' sits in the line, or the only one is the CRLF terminator at the
    // line's last character (a lone CR at the very end of the text is a
    // stray, not a terminator).
    if (text.charCodeAt(pos) !== 34) {
      const eol = text.indexOf('\n', pos);
      const lineEnd = eol === -1 ? n : eol;
      const qi = text.indexOf('"', pos);
      if (qi === -1 || qi >= lineEnd) {
        while (nextCR < pos) {
          const nx = text.indexOf('\r', nextCR + 1);
          nextCR = nx === -1 ? n : nx;
        }
        const crlf = lineEnd < n && nextCR === lineEnd - 1;
        if (nextCR >= lineEnd || crlf) {
          fields = text.slice(pos, crlf ? lineEnd - 1 : lineEnd).split(',');
          pos = lineEnd === n ? n : lineEnd + 1;
          line += 1;
        }
      }
    }

    if (fields === undefined) {
      fields = [];
      let ended;
      do {
        // The unquoted scan below reads onto `base` from pos up to the next
        // comma or line break; a CR not followed by LF is dropped
        // (stray_cr). It writes into uValue/uEnded/uAdded: uAdded counts the
        // characters kept after `base`. It sets pos/line as it goes and
        // pushes stray_cr errors as met. isJunk marks the scan as the junk
        // after a closing quote (an error only when characters were added).
        let base = '';
        let isJunk = false;
        let uValue = '';
        let uEnded = 0;
        let uAdded = 0;
        if (text.charCodeAt(pos) === 34) {
          // A quoted field.
          quoted = true;
          const open = pos;
          const openLine = line;
          // Find the closing quote, skipping doubled quotes.
          let q = text.indexOf('"', pos + 1);
          let doubled = 0;
          while (q !== -1 && text.charCodeAt(q + 1) === 34) {
            doubled += 1;
            q = text.indexOf('"', q + 2);
          }
          if (q === -1) {
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted.
            pos = open + 1;
            line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            base = '"';
          } else {
            // The quoted span holds the raw content, open+1 to q. Slice it
            // first so the break checks below stay inside the span (an
            // unbounded indexOf for '\r' would scan to the next stray CR,
            // which can be kilobytes away in LF files).
            const span = text.slice(open + 1, q);
            const hasBreak = span.indexOf('\n') !== -1 || span.indexOf('\r') !== -1;
            let value;
            if (!hasBreak) {
              value = doubled === 0 ? span : span.replaceAll('""', '"');
            } else {
              // Slow path: line breaks inside quotes become LF, doubled
              // quotes become one quote, and each break counts a line.
              const breaks = span.match(/\r\n|\r|\n/g);
              if (breaks !== null) line += breaks.length;
              value = span.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
              if (doubled > 0) value = value.replaceAll('""', '"');
            }
            pos = q + 1;
            if (pos >= n) {
              fields.push(value);
              ended = END;
              continue;
            }
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              fields.push(value);
              ended = COMMA;
              continue;
            }
            if (c === 10) {
              pos += 1;
              line += 1;
              fields.push(value);
              ended = LINE_BREAK;
              continue;
            }
            if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              fields.push(value);
              ended = LINE_BREAK;
              continue;
            }
            // What follows the closing quote is appended as it stands, up
            // to the next comma or line break: fall through to the unquoted
            // scan with the quoted value as the base.
            base = value;
            isJunk = true;
          }
        } else {
          // An unquoted field.
          quoted = false;
        }
        // --- unquoted scan onto base ---
        uValue = base;
        uAdded = 0;
        for (;;) {
          while (nextCR < pos) {
            const nx = text.indexOf('\r', nextCR + 1);
            nextCR = nx === -1 ? n : nx;
          }
          let c = text.indexOf(',', pos);
          if (c === -1) c = n;
          let nl = text.indexOf('\n', pos);
          if (nl === -1) nl = n;
          if (c < nl) {
            if (nextCR < c) {
              // A stray CR inside the field: dropped, error recorded, on we go.
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              uValue += text.slice(pos, nextCR);
              uAdded += nextCR - pos;
              pos = nextCR + 1;
              continue;
            }
            uValue += text.slice(pos, c);
            uAdded += c - pos;
            pos = c + 1;
            uEnded = COMMA;
            break;
          }
          if (nl === n) {
            if (nextCR < n) {
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              uValue += text.slice(pos, nextCR);
              uAdded += nextCR - pos;
              pos = nextCR + 1;
              continue;
            }
            uValue += text.slice(pos);
            uAdded += n - pos;
            pos = n;
            uEnded = END;
            break;
          }
          if (nextCR < nl - 1) {
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            uValue += text.slice(pos, nextCR);
            uAdded += nextCR - pos;
            pos = nextCR + 1;
            continue;
          }
          const crlf = nextCR === nl - 1;
          const end = crlf ? nl - 1 : nl;
          uValue += text.slice(pos, end);
          uAdded += end - pos;
          pos = nl + 1;
          line += 1;
          uEnded = LINE_BREAK;
          break;
        }
        // A quoted field's junk is an error only when characters were added.
        if (isJunk && uAdded > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
        fields.push(uValue);
        ended = uEnded;
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
