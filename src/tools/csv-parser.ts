export interface CsvRecord {
  recordNumber: number;
  fields: string[];
}

/** Strict RFC-4180-style tokenizer with logical record numbers. */
export function parseCsv(input: string): CsvRecord[] {
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  let lastWasRecordBreak = true;

  const finishRecord = () => {
    fields.push(field);
    records.push({ recordNumber: records.length + 1, fields });
    fields = [];
    field = "";
    closedQuote = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      lastWasRecordBreak = false;
      continue;
    }

    if (character === ",") {
      fields.push(field);
      field = "";
      closedQuote = false;
      lastWasRecordBreak = false;
      continue;
    }
    if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      finishRecord();
      lastWasRecordBreak = true;
      continue;
    }
    if (closedQuote) {
      throw new Error(`Invalid CSV record ${records.length + 1}: unexpected character after closing quote`);
    }
    if (character === '"') {
      if (field.length > 0) throw new Error(`Invalid CSV record ${records.length + 1}: quote inside an unquoted field`);
      quoted = true;
    } else {
      field += character;
    }
    lastWasRecordBreak = false;
  }

  if (quoted) throw new Error(`Invalid CSV record ${records.length + 1}: unclosed quoted field`);
  if (!lastWasRecordBreak) finishRecord();
  return records;
}
