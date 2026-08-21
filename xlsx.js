"use strict";
/**
 * Générateur .xlsx et .csv, 100% autonome (aucune bibliothèque externe) :
 * on ne peut télécharger aucun package sur ce poste, donc le format ZIP
 * (non compressé, méthode "stored") et le XML OOXML minimal sont écrits
 * à la main. Suffisant pour un classeur simple à une feuille, ouvert
 * sans avertissement par Excel.
 */

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- Écriture ZIP (méthode "stored", sans compression) ----------
function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function writeUint32LE(view, offset, value) {
  view.setUint32(offset, value, true);
}
function writeUint16LE(view, offset, value) {
  view.setUint16(offset, value, true);
}

/**
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {Uint8Array}
 */
function buildZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = utf8Bytes(file.name);
    const data = file.data;
    const crc = crc32(data);

    const localHeader = new ArrayBuffer(30);
    const lv = new DataView(localHeader);
    writeUint32LE(lv, 0, 0x04034b50);
    writeUint16LE(lv, 4, 20); // version needed
    writeUint16LE(lv, 6, 0); // flags
    writeUint16LE(lv, 8, 0); // method: stored
    writeUint16LE(lv, 10, 0); // time
    writeUint16LE(lv, 12, 0); // date
    writeUint32LE(lv, 14, crc);
    writeUint32LE(lv, 18, data.length); // compressed size
    writeUint32LE(lv, 22, data.length); // uncompressed size
    writeUint16LE(lv, 26, nameBytes.length);
    writeUint16LE(lv, 28, 0); // extra length

    localChunks.push(new Uint8Array(localHeader), nameBytes, data);

    const centralHeader = new ArrayBuffer(46);
    const cv = new DataView(centralHeader);
    writeUint32LE(cv, 0, 0x02014b50);
    writeUint16LE(cv, 4, 20); // version made by
    writeUint16LE(cv, 6, 20); // version needed
    writeUint16LE(cv, 8, 0); // flags
    writeUint16LE(cv, 10, 0); // method
    writeUint16LE(cv, 12, 0); // time
    writeUint16LE(cv, 14, 0); // date
    writeUint32LE(cv, 16, crc);
    writeUint32LE(cv, 20, data.length);
    writeUint32LE(cv, 24, data.length);
    writeUint16LE(cv, 28, nameBytes.length);
    writeUint16LE(cv, 30, 0); // extra length
    writeUint16LE(cv, 32, 0); // comment length
    writeUint16LE(cv, 34, 0); // disk number start
    writeUint16LE(cv, 36, 0); // internal attrs
    writeUint32LE(cv, 38, 0); // external attrs
    writeUint32LE(cv, 42, offset); // offset of local header

    centralChunks.push(new Uint8Array(centralHeader), nameBytes);

    offset += localHeader.byteLength + nameBytes.length + data.length;
  }

  const centralSize = centralChunks.reduce((sum, c) => sum + c.length, 0);
  const centralOffset = offset;

  const endRecord = new ArrayBuffer(22);
  const ev = new DataView(endRecord);
  writeUint32LE(ev, 0, 0x06054b50);
  writeUint16LE(ev, 4, 0); // disk number
  writeUint16LE(ev, 6, 0); // disk with central dir
  writeUint16LE(ev, 8, files.length);
  writeUint16LE(ev, 10, files.length);
  writeUint32LE(ev, 12, centralSize);
  writeUint32LE(ev, 16, centralOffset);
  writeUint16LE(ev, 20, 0); // comment length

  const allChunks = [...localChunks, ...centralChunks, new Uint8Array(endRecord)];
  const totalLength = allChunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of allChunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

// ---------- OOXML minimal (une feuille, chaînes en ligne, pas de styles avancés) ----------
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const COLUMN_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

/**
 * @param {Array<Array<{type: 's'|'n', value: any}>>} rows
 */
function buildSheetXml(rows) {
  const rowXmls = rows.map((row, rowIndex) => {
    const rowNum = rowIndex + 1;
    const cellXmls = row.map((cell, colIndex) => {
      const ref = `${COLUMN_LETTERS[colIndex]}${rowNum}`;
      if (cell.type === "n") {
        const num = Number(cell.value) || 0;
        return `<c r="${ref}"><v>${num}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.value ?? "")}</t></is></c>`;
    });
    return `<row r="${rowNum}">${cellXmls.join("")}</row>`;
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXmls.join("")}</sheetData></worksheet>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inventaire" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`;

/**
 * Construit un classeur .xlsx à partir de lignes de cellules typées.
 * @param {Array<Array<{type:'s'|'n', value:any}>>} rows
 * @returns {Uint8Array}
 */
function buildXlsx(rows) {
  const files = [
    { name: "[Content_Types].xml", data: utf8Bytes(CONTENT_TYPES_XML) },
    { name: "_rels/.rels", data: utf8Bytes(RELS_XML) },
    { name: "xl/workbook.xml", data: utf8Bytes(WORKBOOK_XML) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8Bytes(WORKBOOK_RELS_XML) },
    { name: "xl/styles.xml", data: utf8Bytes(STYLES_XML) },
    { name: "xl/worksheets/sheet1.xml", data: utf8Bytes(buildSheetXml(rows)) },
  ];
  return buildZip(files);
}

/**
 * Construit un CSV avec séparateur ';' (compatible Excel), BOM UTF-8 inclus.
 * @param {Array<Array<any>>} rows
 * @returns {Uint8Array}
 */
function buildCsv(rows) {
  const lines = rows.map((row) =>
    row
      .map((value) => {
        const str = value === null || value === undefined ? "" : String(value);
        if (/[;"\n]/.test(str)) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(";")
  );
  const text = lines.join("\r\n");
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const body = utf8Bytes(text);
  const result = new Uint8Array(bom.length + body.length);
  result.set(bom, 0);
  result.set(body, bom.length);
  return result;
}
