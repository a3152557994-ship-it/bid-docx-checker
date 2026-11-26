/**
 * BidGuard 标书排雷王 (bid-docx-checker) — 100% Pure-Local Binary .docx Disqualification Cross-Verifier.
 * Zero external dependencies. Runs identically in Modern Browsers (File / ArrayBuffer + DecompressionStream)
 * and Node.js (Buffer + DecompressionStream / node:zlib).
 */

export const PUBLIC_SPKI_BASE64 = "MCowBQYDK2VwAyEAP5NCVP7CT0tgaGLSGMe4r87SjYRWTM6gN6igBZYSXys=";
export const PRODUCT_SLUG = "bid-docx-checker";
export const FREE_PREVIEW_ISSUES = 2;

export const MINEFIELD_CATEGORIES = [
  { id: "amount_mismatch", code: "M1", zhLabel: "大小写金额不符", severity: "fatal", icon: "💰" },
  { id: "entity_leak", code: "M2", zhLabel: "页眉页脚/正文串名残留", severity: "fatal", icon: "🏢" },
  { id: "duration_conflict", code: "M3", zhLabel: "工期日历天数冲突", severity: "fatal", icon: "📅" },
  { id: "placeholder_leftover", code: "M4", zhLabel: "未填模板占位符残留", severity: "high", icon: "📝" },
  { id: "missing_anchor", code: "M5", zhLabel: "关键签章/授权书锚点缺失", severity: "fatal", icon: "🔏" },
  { id: "expired_qualification", code: "M6", zhLabel: "资质证书有效期过期", severity: "fatal", icon: "⚠️" },
];

export const DEFAULT_SAMPLE_META = {
  bidDate: "2026-11-20",
  expectedPurchaser: "杭州滨江智慧园区管理委员会",
  expectedBidder: "浙江数智安防科技有限公司",
  expectedProjectName: "2026年杭州滨江智慧园区安防升级采购项目",
};

// Precompute standard IEEE 802.3 CRC-32 lookup table for binary .docx construction
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input && typeof input.arrayBuffer === "function") {
    const ab = await input.arrayBuffer();
    return new Uint8Array(ab);
  }
  throw new Error("Unsupported binary input: expected File, Blob, ArrayBuffer, or Uint8Array/Buffer");
}

async function inflateRawBytes(compressedBytes, options = {}) {
  if (!options.forceNodeZlib && typeof globalThis.DecompressionStream === "function") {
    const ds = new globalThis.DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(compressedBytes);
    writer.close();
    const res = new Response(ds.readable);
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }

  // Fallback for older Node environments without global DecompressionStream
  const zlib = await import("node:zlib");
  return new Uint8Array(zlib.inflateRawSync(compressedBytes));
}

async function deflateRawBytes(rawBytes) {
  if (typeof globalThis.CompressionStream === "function") {
    const cs = new globalThis.CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    writer.write(rawBytes);
    writer.close();
    const res = new Response(cs.readable);
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }
  const zlib = await import("node:zlib");
  return new Uint8Array(zlib.deflateRawSync(rawBytes));
}

/**
 * Pure-JS ZIP Central Directory reader for .docx archives.
 * Extracts `word/document.xml`, `word/header*.xml`, and `word/footer*.xml` without external libraries.
 */
export async function extractDocxXmlEntries(binaryInput, options = {}) {
  const bytes = await toUint8Array(binaryInput);
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("无效的 .docx 文件头：未检测到标准 PK ZIP 二进制签名（请确认文件为 .docx 而非旧版 .doc）");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate End of Central Directory (0x06054b50) from end of file
  let eocdOffset = -1;
  const minEocdSearch = Math.max(0, bytes.length - 65557);
  for (let pos = bytes.length - 22; pos >= minEocdSearch; pos -= 1) {
    if (view.getUint32(pos, true) === 0x06054b50) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("无法解析 .docx ZIP 中央目录（EOCD 缺失或文件损坏）");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  if (cdOffset + cdSize > bytes.length) {
    throw new Error(".docx 中央目录偏移越界，文件可能被截断");
  }

  const decoder = new TextDecoder("utf-8");
  const xmlFiles = {};
  const allEntryNames = [];

  let ptr = cdOffset;
  for (let i = 0; i < totalEntries && ptr + 46 <= bytes.length; i += 1) {
    const sig = view.getUint32(ptr, true);
    if (sig !== 0x02014b50) {
      throw new Error("无效的 ZIP 中央目录条目签名");
    }

    const compressionMethod = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);

    const entryName = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    allEntryNames.push(entryName);

    const isTargetWordXml =
      entryName === "word/document.xml" ||
      /^word\/header\d*\.xml$/i.test(entryName) ||
      /^word\/footer\d*\.xml$/i.test(entryName);

    if (isTargetWordXml) {
      if (localHeaderOffset + 30 > bytes.length || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
        throw new Error(`无法读取 ${entryName} 的本地文件头`);
      }
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) {
        throw new Error(`${entryName} 压缩数据长度越界`);
      }

      const rawSlice = bytes.subarray(dataStart, dataEnd);
      let uncompressedBytes;
      if (compressionMethod === 0) {
        uncompressedBytes = rawSlice;
      } else if (compressionMethod === 8) {
        uncompressedBytes = await inflateRawBytes(rawSlice, options);
      } else {
        throw new Error(`不支持的 ZIP 压缩算法 (${compressionMethod}) 于 ${entryName}`);
      }

      xmlFiles[entryName] = decoder.decode(uncompressedBytes);
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  if (!xmlFiles["word/document.xml"]) {
    throw new Error("该压缩包内未找到 word/document.xml，不是有效的 Word (.docx) 标书文档");
  }

  return {
    entryCount: allEntryNames.length,
    entryNames: allEntryNames,
    xmlFiles,
  };
}

/**
 * Pure-JS binary .docx ZIP packer (Method 8 deflate-raw + CRC32 + Central Directory).
 * Used both for building the downloadable browser demo .docx and testing end-to-end binary streams.
 */
export async function packDocxArchive(textFilesMap) {
  const encoder = new TextEncoder();
  const entries = [];
  let offset = 0;

  for (const [name, content] of Object.entries(textFilesMap)) {
    const nameBytes = encoder.encode(name);
    const rawBytes = content instanceof Uint8Array ? content : encoder.encode(String(content));
    const compressedBytes = await deflateRawBytes(rawBytes);
    const checksum = crc32(rawBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true); // Version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lv.setUint16(8, 8, true); // Compression method: 8 (deflate-raw)
    lv.setUint16(10, 0, true); // Mod time
    lv.setUint16(12, 0, true); // Mod date
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, compressedBytes.length, true);
    lv.setUint32(22, rawBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    entries.push({
      nameBytes,
      rawLen: rawBytes.length,
      compLen: compressedBytes.length,
      checksum,
      localHeader,
      compressedBytes,
      localOffset: offset,
    });

    offset += localHeader.length + compressedBytes.length;
  }

  const centralHeaders = [];
  let cdSize = 0;

  for (const e of entries) {
    const cd = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, e.checksum, true);
    cv.setUint32(20, e.compLen, true);
    cv.setUint32(24, e.rawLen, true);
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, e.localOffset, true);
    cd.set(e.nameBytes, 46);
    centralHeaders.push(cd);
    cdSize += cd.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalLen = offset + cdSize + eocd.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const e of entries) {
    out.set(e.localHeader, pos);
    pos += e.localHeader.length;
    out.set(e.compressedBytes, pos);
    pos += e.compressedBytes.length;
  }
  for (const cd of centralHeaders) {
    out.set(cd, pos);
    pos += cd.length;
  }
  out.set(eocd, pos);
  return out;
}

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a realistic sample .docx binary buffer containing 6 subtle fatal disqualification traps.
 */
export async function buildSampleTrapDocxBuffer() {
  const paragraphs = [
    "2026年杭州滨江智慧园区安防升级采购项目 · 投标文件",
    "采购人：杭州滨江智慧园区管理委员会",
    "投标人：浙江数智安防科技有限公司",
    "一、投标函",
    "致：杭州滨江智慧园区管理委员会：我方已详细审阅招标文件全部内容，愿意以人民币大写：壹佰贰拾捌万元整（小写：¥1,208,000.00）的投标总报价承接本项目全部软硬件供货与集成任务。",
    "商务承诺工期：合同签订之日起 90 日历天内完成全部设备安装、联调与终验移交。",
    "二、开标一览表（报价一览表）",
    "三、技术偏离与施工组织设计",
    "施工进度总控目标：我方承诺本项目总工期为 60 日历天（计划开工日期：2026年12月01日，计划竣工日期：2027年01月15日），确保按期交付。",
    "本地化维保承诺：在质保期内，上海旧模版系统集成有限公司将派遣 2 名驻场工程师提供 7×24 小时响应，质保金于验收满后【待填】个工作日内无息退还。",
    "拟派项目经理：张工，身份证号：____，联系电话：1380000XXXX，常驻技术骨干：XXX。",
    "四、资格审查及企业资质证明文件",
    "1. 建筑智能化安全生产许可证（编号：浙JZ安许证字[2023]009812），有效期至2026年06月30日。",
    "2. 信息安全管理体系认证证书（ISO27001），证书有效期：2023年05月10日至2026年05月09日。",
    "投标人（盖章）：浙江数智安防科技有限公司    签署日期：202X年11月20日",
  ];

  const pXml = paragraphs
    .map((t) => `<w:p><w:r><w:t>${escapeXml(t)}</w:t></w:r></w:p>`)
    .join("");

  const tableXml = `
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>项目名称</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>投标总价（大写）</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>投标总价（小写）</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>2026年杭州滨江智慧园区安防升级采购项目</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>人民币壹佰贰拾捌万元整</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>¥1,280,000.00</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  `;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${pXml}${tableXml}</w:body>
</w:document>`;

  const header1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>宁波市鄞州区政务云扩容项目投标文件 · 采购人：宁波市大数据发展管理局</w:t></w:r></w:p>
</w:hdr>`;

  const footer1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>机密标书 · 严禁外传</w:t></w:r></w:p>
</w:ftr>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  return packDocxArchive({
    "[Content_Types].xml": contentTypesXml,
    "_rels/.rels": relsXml,
    "word/document.xml": documentXml,
    "word/header1.xml": header1Xml,
    "word/footer1.xml": footer1Xml,
  });
}

function decodeXmlEntities(str) {
  return String(str || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function extractWordTextNodes(xmlFragment) {
  const texts = [];
  const re = /<w:t(?:\s+[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(xmlFragment)) !== null) {
    texts.push(decodeXmlEntities(m[1]));
  }
  return texts.join("").replace(/\s+/g, " ").trim();
}

/**
 * Parse Word XML files into structured location segments (Headers, Footers, Body Paragraphs, Table Rows).
 */
export function parseWordXmlSegments(xmlFiles) {
  const segments = [];

  // 1. Headers & Footers
  for (const [entryName, xml] of Object.entries(xmlFiles)) {
    if (entryName === "word/document.xml") continue;
    const isHeader = entryName.includes("header");
    const labelPrefix = isHeader ? `页眉 (${entryName})` : `页脚 (${entryName})`;
    const pMatches = xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || [];
    pMatches.forEach((pXml, idx) => {
      const text = extractWordTextNodes(pXml);
      if (text) {
        segments.push({
          source: isHeader ? "header" : "footer",
          entryName,
          location: `${labelPrefix} 第 ${idx + 1} 行`,
          text,
        });
      }
    });
  }

  // 2. Main Document Body: extract table rows (<w:tr>) first and non-table paragraphs (<w:p>)
  const docXml = xmlFiles["word/document.xml"] || "";

  // Strip tables temporarily to enumerate standalone body paragraphs accurately
  const bodyWithoutTables = docXml.replace(/<w:tbl[\s>][\s\S]*?<\/w:tbl>/g, "");
  const bodyParas = bodyWithoutTables.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || [];
  bodyParas.forEach((pXml, idx) => {
    const text = extractWordTextNodes(pXml);
    if (text) {
      segments.push({
        source: "paragraph",
        entryName: "word/document.xml",
        location: `正文第 ${idx + 1} 段`,
        text,
      });
    }
  });

  // Extract tables and each table row (<w:tr>) so uppercase & lowercase cells in the same row are cross-checked
  const tables = docXml.match(/<w:tbl[\s>][\s\S]*?<\/w:tbl>/g) || [];
  tables.forEach((tblXml, tIdx) => {
    const rows = tblXml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || [];
    rows.forEach((trXml, rIdx) => {
      const cells = (trXml.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) || [])
        .map((tc) => extractWordTextNodes(tc))
        .filter(Boolean);
      if (cells.length > 0) {
        segments.push({
          source: "table_row",
          entryName: "word/document.xml",
          location: `表格 #${tIdx + 1} 第 ${rIdx + 1} 行`,
          cells,
          text: cells.join(" | "),
        });
      }
    });
  });

  return segments;
}

const CN_DIGITS = {
  零: 0, 〇: 0,
  壹: 1, 一: 1,
  贰: 2, 貳: 2, 二: 2, 两: 2,
  叁: 3, 參: 3, 三: 3,
  肆: 4, 四: 4,
  伍: 5, 五: 5,
  陆: 6, 陸: 6, 六: 6,
  柒: 7, 七: 7,
  捌: 8, 八: 8,
  玖: 9, 九: 9,
};

const CN_SMALL_UNITS = {
  拾: 10, 十: 10,
  佰: 100, 百: 100,
  仟: 1000, 千: 1000,
};

const CN_SECTION_UNITS = {
  万: 10000, 萬: 10000,
  亿: 100000000, 億: 100000000,
};

function parseChineseIntegerPart(intChars) {
  let total = 0;
  let section = 0;
  let currentDigit = 0;
  let hasAnyDigitOrUnit = false;

  for (const ch of intChars) {
    if (ch in CN_DIGITS) {
      currentDigit = CN_DIGITS[ch];
      hasAnyDigitOrUnit = true;
    } else if (ch in CN_SMALL_UNITS) {
      const unit = CN_SMALL_UNITS[ch];
      const mult = currentDigit === 0 && (ch === "拾" || ch === "十") && section === 0 ? 1 : currentDigit;
      section += mult * unit;
      currentDigit = 0;
      hasAnyDigitOrUnit = true;
    } else if (ch in CN_SECTION_UNITS) {
      const secUnit = CN_SECTION_UNITS[ch];
      section += currentDigit;
      currentDigit = 0;
      if (secUnit === 100000000) {
        total = (total + section) * 100000000;
        section = 0;
      } else {
        total += section * secUnit;
        section = 0;
      }
      hasAnyDigitOrUnit = true;
    }
  }

  if (!hasAnyDigitOrUnit) return null;
  return total + section + currentDigit;
}

/**
 * Exact mathematical converter from Chinese RMB Uppercase string to integer cents (分).
 * Example: "壹佰贰拾捌万元整" -> 128000000 (cents = ¥1,280,000.00)
 * Example: "壹亿零伍佰万零捌拾元伍角叁分" -> 10500008053 (cents = ¥105,000,080.53)
 * @param {string} raw
 * @returns {number|null} Integer cents, or null if not a valid RMB uppercase amount.
 */
export function parseChineseRmbToCents(raw) {
  const cleaned = String(raw || "")
    .replace(/^(?:人民币|大写金额|大写|合计大写|总价大写|报价大写|[：:\s])+/g, "")
    .replace(/\s+/g, "")
    .trim();

  if (!cleaned || !/[零〇壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万萬亿億]/.test(cleaned)) {
    return null;
  }
  if (!/[圆元角分]/.test(cleaned)) {
    return null;
  }

  let yuan = 0;
  let jiao = 0;
  let fen = 0;

  const yuanSplit = cleaned.match(/^(.*?)[圆元](.*)$/);
  let fractionPart = "";

  if (yuanSplit) {
    const intStr = yuanSplit[1];
    fractionPart = yuanSplit[2] || "";
    if (intStr.length > 0) {
      const parsedInt = parseChineseIntegerPart(intStr);
      if (parsedInt === null) return null;
      yuan = parsedInt;
    }
  } else {
    fractionPart = cleaned;
  }

  fractionPart = fractionPart.replace(/[整正]/g, "");

  if (fractionPart.length > 0) {
    const jiaoMatch = fractionPart.match(/([零〇壹贰貳叁參肆伍陆陸柒捌玖一二三四五六七八九])角/);
    if (jiaoMatch) {
      jiao = CN_DIGITS[jiaoMatch[1]] ?? 0;
    }
    const fenMatch = fractionPart.match(/([零〇壹贰貳叁參肆伍陆陸柒捌玖一二三四五六七八九])分/);
    if (fenMatch) {
      fen = CN_DIGITS[fenMatch[1]] ?? 0;
    }
  }

  return Math.round(yuan * 100 + jiao * 10 + fen);
}

/**
 * Parse numeric RMB currency expression (e.g., "¥1,208,000.00", "小写：128.50万元") into integer cents.
 */
export function parseNumericRmbToCents(raw) {
  const str = String(raw || "").trim();
  const m = str.match(/(?:[¥￥]|小写[：:\s]*|RMB\s*)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]{1,6}))?\s*(万元|万|元)?/i);
  if (!m) return null;
  const intDigits = m[1].replace(/,/g, "");
  const decDigits = m[2] || "";
  const unit = m[3] || "";
  const val = parseFloat(`${intDigits}.${decDigits || "0"}`);
  if (!Number.isFinite(val)) return null;
  const multiplier = unit.startsWith("万") ? 10000 * 100 : 100;
  return Math.round(val * multiplier);
}

export function formatCentsAsYuan(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const yuan = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  const formattedYuan = yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}¥${formattedYuan}.${rem}`;
}

function parseChineseDateToUtcMs(dateStr) {
  const m = String(dateStr || "").match(/(20\d{2})\s*[年./-]\s*(0?[1-9]|1[0-2])\s*[月./-]\s*(0?[1-9]|[12]\d|3[01])\s*日?/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function pairRmbUpperAndLower(text, isTableRow = false) {
  const rmbUpperRegex = /(?:人民币)?(?:大写金额|大写|合计大写|总价大写|报价大写)?[：:\s]*([零〇壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万萬亿億]+[圆元][零〇壹贰貳叁參肆伍陆陸柒捌玖角分整正]*)/g;
  const rmbLowerRegex = /(?:[¥￥]\s*[0-9][0-9,]*(?:\.[0-9]{1,6})?\s*(?:万元|万|元)?|小写[：:\s]*[¥￥]?\s*[0-9][0-9,]*(?:\.[0-9]{1,6})?\s*(?:万元|万|元)?|[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,6})?\s*(?:万元|万|元)?|[0-9]+(?:\.[0-9]{1,6})?\s*(?:万元|元))/g;

  const uppers = [];
  for (const m of text.matchAll(rmbUpperRegex)) {
    const raw = m[1];
    const cents = parseChineseRmbToCents(raw);
    if (cents !== null) {
      uppers.push({
        raw,
        full: m[0],
        start: m.index,
        end: m.index + m[0].length,
        cents,
        used: false,
      });
    }
  }

  const lowers = [];
  for (const m of text.matchAll(rmbLowerRegex)) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    // Skip if overlapping an uppercase match
    if (uppers.some((u) => start < u.end && end > u.start)) continue;
    const cents = parseNumericRmbToCents(raw);
    if (cents !== null) {
      lowers.push({ raw, start, end, cents, used: false });
    }
  }

  const pairs = [];

  // Pass 1: Adjacent parentheses / brackets pairing — e.g. 肆拾捌万元（480,000元） or ¥480,000.00（大写：肆拾捌万元整）
  for (const u of uppers) {
    if (u.used) continue;
    for (const l of lowers) {
      if (l.used) continue;
      if (l.start >= u.end) {
        const between = text.slice(u.end, l.start);
        const after = text.slice(l.end, l.end + 6);
        if (/^\s*[（(【\[]\s*(?:人民币|小写金额|小写|RMB|[：:\s])*$/i.test(between) && /^\s*[)）】\]]/.test(after)) {
          u.used = true;
          l.used = true;
          pairs.push({ u, l });
          break;
        }
      } else if (u.start >= l.end) {
        const between = text.slice(l.end, u.start);
        const after = text.slice(u.end, u.end + 6);
        if (/^\s*[（(【\[]\s*(?:人民币|大写金额|大写|[：:\s])*$/i.test(between) && /^\s*[)）】\]]/.test(after)) {
          u.used = true;
          l.used = true;
          pairs.push({ u, l });
          break;
        }
      }
    }
  }

  const hasBudgetRole = (ctx) => /(?:预算|最高限价|限价|控制价|拦标价|保证金)/.test(ctx);
  const hasBidRole = (ctx) => /(?:投标报价|我方报价|总报价|投标总价|报价合计|报价为|总价为)/.test(ctx);

  // Pass 2: Same-clause or same-table-row contextual pairing for remaining unconsumed amounts
  for (const u of uppers) {
    if (u.used) continue;
    const uCtx = text.slice(Math.max(0, u.start - 16), u.start);
    let bestL = null;
    let bestDist = Infinity;

    for (const l of lowers) {
      if (l.used) continue;
      const lCtx = text.slice(Math.max(0, l.start - 16), l.start);
      if ((hasBudgetRole(lCtx) && hasBidRole(uCtx)) || (hasBudgetRole(uCtx) && hasBidRole(lCtx))) {
        continue;
      }

      const leftEnd = Math.min(u.end, l.end);
      const rightStart = Math.max(u.start, l.start);
      const span = text.slice(leftEnd, rightStart);

      if (!isTableRow) {
        const explicitLink =
          u.end <= l.start
            ? /^\s*[，,、；;]?\s*(?:人民币)?(?:小写金额|小写|RMB|[¥￥])[：:\s]*/i.test(span)
            : /^\s*[，,、；;]?\s*(?:人民币)?(?:大写金额|大写)[：:\s]*/i.test(span);
        const crossesClause = /[，。；;！？\n]|(?<!\d),(?!\d)/.test(span);
        if (crossesClause && !explicitLink) {
          continue;
        }
      }

      const dist = Math.abs(l.start - u.start);
      if (dist < bestDist) {
        bestDist = dist;
        bestL = l;
      }
    }

    if (bestL) {
      u.used = true;
      bestL.used = true;
      pairs.push({ u, l: bestL });
    } else {
      pairs.push({ u, l: null });
    }
  }

  return pairs;
}

function normalizeOrg(name) {
  return String(name || "")
    .replace(/[（）()\s·.,，。：:]/g, "")
    .trim();
}

/**
 * Run all 6 disqualification minefield audits across parsed Word segments.
 */
export function auditSegments(segments, options = {}) {
  const bidDateStr = options.bidDate || new Date().toISOString().slice(0, 10);
  const bidDateMs = parseChineseDateToUtcMs(bidDateStr) ?? Date.UTC(2026, 10, 17);
  const expectedPurchaser = normalizeOrg(options.expectedPurchaser);
  const expectedBidder = normalizeOrg(options.expectedBidder);
  const expectedProjectName = normalizeOrg(options.expectedProjectName);

  const issues = [];

  // Track global bid total amounts & global durations across the entire document
  const detectedTotals = [];
  const detectedDurations = [];

  // Minefield 1: RMB Uppercase vs Numeric Lowercase Mismatch (adjacent-parentheses & same-clause aware)
  for (const seg of segments) {
    const matchedPairs = pairRmbUpperAndLower(seg.text, seg.source === "table_row");
    for (const { u, l } of matchedPairs) {
      const upRaw = u.raw;
      const upCents = u.cents;
      if (l) {
        const lowRaw = l.raw;
        const lowCents = l.cents;
        if (upCents !== null && lowCents !== null && upCents !== lowCents) {
          const diffCents = Math.abs(upCents - lowCents);
          issues.push({
            categoryId: "amount_mismatch",
            code: "M1",
            severity: "fatal",
            title: "人民币大写金额与同处小写金额数学换算不一致（一票否决废标项）",
            location: seg.location,
            excerpt: seg.text,
            detail: `大写「${upRaw}」换算值为 ${formatCentsAsYuan(upCents)}，但对应小写「${lowRaw.trim()}」为 ${formatCentsAsYuan(lowCents)}，两者相差 ${formatCentsAsYuan(diffCents)}。评标办法虽规定大小写不一致以大写为准，但总价偏离极易导致修正后超预算废标或算术扣分！`,
            fixAction: `立即核对财务底表，将该处大写与小写统一修正为完全一致的精确金额。`,
          });
        } else if (upCents !== null && /(总报价|投标总价|报价合计|我方报价|投标报价)/.test(seg.text)) {
          detectedTotals.push({ cents: upCents, location: seg.location, raw: upRaw });
        }
      } else if (upCents !== null && /(总报价|投标总价|报价合计|我方报价|投标报价)/.test(seg.text)) {
        detectedTotals.push({ cents: upCents, location: seg.location, raw: upRaw });
      }
    }
  }

  // Cross-section total bid consistency check (if multiple totals exist and disagree)
  if (detectedTotals.length >= 2) {
    const base = detectedTotals[0];
    for (let i = 1; i < detectedTotals.length; i += 1) {
      if (detectedTotals[i].cents !== base.cents) {
        issues.push({
          categoryId: "amount_mismatch",
          code: "M1",
          severity: "fatal",
          title: "前后章节投标总报价金额互相矛盾",
          location: `${base.location} vs ${detectedTotals[i].location}`,
          excerpt: `${base.raw} vs ${detectedTotals[i].raw}`,
          detail: `${base.location} 报价为 ${formatCentsAsYuan(base.cents)}，而 ${detectedTotals[i].location} 报价为 ${formatCentsAsYuan(detectedTotals[i].cents)}。`,
          fixAction: "统一《投标函》与《开标一览表》及分项汇总表的总报价。",
        });
      }
    }
  }

  // Minefield 2: Foreign Purchaser / Competitor / Wrong Project Name Leak in Headers, Footers & Body
  const orgMentionRegex = /([\u4e00-\u9fa5]{2,22}(?:有限公司|股份有限公司|集团有限公司|管理局|委员会|财政局|住建局|教育局|卫健委|采购中心|大数据局|大数据发展管理局|政务服务局))/g;
  const projMentionRegex = /([\u4e00-\u9fa50-9A-Za-z]{4,30}(?:采购项目|建设项目|扩容项目|改造项目|招标项目))/g;

  for (const seg of segments) {
    // Check explicit project names against expectedProjectName (especially in headers/footers)
    if (expectedProjectName || seg.source === "header" || seg.source === "footer") {
      for (const pm of seg.text.matchAll(projMentionRegex)) {
        const foundProj = normalizeOrg(pm[1]);
        if (
          expectedProjectName &&
          foundProj &&
          !expectedProjectName.includes(foundProj) &&
          !foundProj.includes(expectedProjectName)
        ) {
          issues.push({
            categoryId: "entity_leak",
            code: "M2",
            severity: "fatal",
            title: `${seg.source === "header" ? "页眉" : "正文"}残留其他历史招投标项目名称`,
            location: seg.location,
            excerpt: seg.text,
            detail: `检测到异名项目「${pm[1]}」，与本次目标项目「${options.expectedProjectName}」不一致（常见于套用旧标书忘记改页眉）。`,
            fixAction: `双击 Word 页眉/页脚取消“链接到前一节”，将「${pm[1]}」彻底替换为「${options.expectedProjectName}」。`,
          });
        }
      }
    }

    // Check organization names against expectedPurchaser & expectedBidder
    if (expectedPurchaser || expectedBidder) {
      for (const om of seg.text.matchAll(orgMentionRegex)) {
        const rawOrg = om[1].replace(/^(?:致|采购人|招标人|投标人|由|在|向|与)+/, "");
        const norm = normalizeOrg(rawOrg);
        if (!norm || norm.length < 5) continue;

        const matchesPurchaser =
          expectedPurchaser && (expectedPurchaser.includes(norm) || norm.includes(expectedPurchaser));
        const matchesBidder =
          expectedBidder && (expectedBidder.includes(norm) || norm.includes(expectedBidder));

        if (!matchesPurchaser && !matchesBidder) {
          issues.push({
            categoryId: "entity_leak",
            code: "M2",
            severity: "fatal",
            title: "疑似串名残留：出现非本次招标人/投标人的第三方单位或异地机关名称",
            location: seg.location,
            excerpt: seg.text,
            detail: `检测到外部单位/机关名称「${rawOrg}」，既不匹配本次招标人「${options.expectedPurchaser || "未设"}」，也不匹配本次投标人「${options.expectedBidder || "未设"}」。`,
            fixAction: `全文搜索「${rawOrg}」，确认是否为上次投标残留的采购人或旧模板公司名并予以更正。`,
          });
        }
      }
    }
  }

  // Minefield 3: Duration / Calendar Days Conflict (前后工期不一致 & 开竣工日期相减冲突)
  const durationRegex = /(?:总?工期|交货期|服务期|完工期)[^0-9\n。；]{0,10}?(\d{1,4})\s*个?\s*日历[天日]/g;
  const startEndRegex = /开工日期[：:\s]*(20\d{2}年\d{1,2}月\d{1,2}日)[^。；\n]{0,25}?竣工日期[：:\s]*(20\d{2}年\d{1,2}月\d{1,2}日)/;

  for (const seg of segments) {
    for (const dm of seg.text.matchAll(durationRegex)) {
      const days = Number(dm[1]);
      detectedDurations.push({ days, location: seg.location, excerpt: seg.text });

      // Check if same paragraph also gives start/end dates that conflict with declared calendar days
      const se = seg.text.match(startEndRegex);
      if (se) {
        const startMs = parseChineseDateToUtcMs(se[1]);
        const endMs = parseChineseDateToUtcMs(se[2]);
        if (startMs !== null && endMs !== null) {
          const inclusiveDays = Math.round((endMs - startMs) / 86400000) + 1;
          const exclusiveDays = Math.round((endMs - startMs) / 86400000);
          if (days !== inclusiveDays && days !== exclusiveDays) {
            issues.push({
              categoryId: "duration_conflict",
              code: "M3",
              severity: "fatal",
              title: "承诺工期日历天数与计划开竣工日期测算天数矛盾",
              location: seg.location,
              excerpt: seg.text,
              detail: `文字承诺工期为 ${days} 日历天，但计划开工（${se[1]}）至计划竣工（${se[2]}）实际跨度仅为 ${inclusiveDays} 日历天（差值 ${exclusiveDays} 天），前后逻辑自相矛盾。`,
              fixAction: "重新核算施工横道图，确保「总工期日历天数 = 竣工日期 - 开工日期 + 1」。",
            });
          }
        }
      }
    }
  }

  if (detectedDurations.length >= 2) {
    const firstDur = detectedDurations[0];
    for (let i = 1; i < detectedDurations.length; i += 1) {
      if (detectedDurations[i].days !== firstDur.days) {
        issues.push({
          categoryId: "duration_conflict",
          code: "M3",
          severity: "fatal",
          title: "标书前后章节承诺工期（日历天）不一致",
          location: `${firstDur.location} vs ${detectedDurations[i].location}`,
          excerpt: `${firstDur.location}：「${firstDur.days}日历天」 ≠ ${detectedDurations[i].location}：「${detectedDurations[i].days}日历天」`,
          detail: `前文（${firstDur.location}）承诺 ${firstDur.days} 日历天，后文（${detectedDurations[i].location}）却写为 ${detectedDurations[i].days} 日历天，属典型实质性响应前后矛盾废标项！`,
          fixAction: `全文搜索“日历天”与“工期”，统一所有商务及技术章节工期表述。`,
        });
      }
    }
  }

  // Minefield 4: Unfilled Template Placeholders
  const placeholderPatterns = [
    { re: /【\s*(?:待填|请填写|待补充|此处填写|略)\s*】/, label: "【待填】模板括号" },
    { re: /[（(]\s*(?:请填写|待填|待补充|空白)\s*[)）]/, label: "（请填写）提示符" },
    { re: /_{3,}/, label: "连续空白下划线 ____" },
    { re: /20[2X]X\s*年/i, label: "未填年份 202X年" },
    { re: /(?:^|[^A-Za-z])(?:XXX|×××)(?:$|[^A-Za-z])/, label: "未替换占位符 XXX" },
  ];

  for (const seg of segments) {
    const hitLabels = placeholderPatterns
      .filter((p) => p.re.test(seg.text))
      .map((p) => p.label);

    if (hitLabels.length > 0) {
      issues.push({
        categoryId: "placeholder_leftover",
        code: "M4",
        severity: "high",
        title: `残留未填写的招标模板占位符（${hitLabels.join("、")}）`,
        location: seg.location,
        excerpt: seg.text,
        detail: `在该段落检测到未替换完的母版占位标记：${hitLabels.join("、")}。关键人员身份证或签署日期漏填将直接导致形式评审不合格。`,
        fixAction: "逐一填入真实人员信息、天数与正式签署日期，严禁留空或保留 X/下划线。",
      });
    }
  }

  // Minefield 5: Missing Statutory Bid Sections & Seal/Signature Anchors
  const fullCorpus = segments.map((s) => s.text).join("\n");
  const requiredAnchors = [
    {
      id: "bid_letter",
      name: "《投标函》核心章节锚点",
      re: /投\s*标\s*函/,
    },
    {
      id: "legal_auth",
      name: "《法定代表人授权委托书》章节锚点",
      re: /法定代表人授权(?:委托)?书|授权委托书/,
    },
    {
      id: "price_summary",
      name: "《开标一览表 / 报价一览表》锚点",
      re: /(?:开标|报价)一览表/,
    },
    {
      id: "bidder_seal",
      name: "投标人单位公章盖章锚点",
      re: /投标人\s*[（(]?盖\s*章|单位公章|加盖公章/,
    },
    {
      id: "rep_signature",
      name: "法定代表人或委托代理人签字锚点",
      re: /(?:法定代表人|委托代理人|授权代表)[^。\n]{0,12}(?:签字|签章)/,
    },
  ];

  const missingAnchors = requiredAnchors.filter((a) => !a.re.test(fullCorpus));
  if (missingAnchors.length > 0) {
    issues.push({
      categoryId: "missing_anchor",
      code: "M5",
      severity: "fatal",
      title: `缺失 ${missingAnchors.length} 处法定废标必查章节/签章锚点`,
      location: "全文结构完整性扫描 (word/document.xml)",
      excerpt: `未检出：${missingAnchors.map((m) => m.name).join("；")}`,
      detail: `资格与形式评审必查的法定要件缺失（${missingAnchors.map((m) => m.name).join("、")}），漏放授权书或漏留法定代表人签字位属于最高频废标原因之一。`,
      fixAction: "对照招标文件第六章《投标文件格式》，补齐缺失的授权委托书及法定代表人/授权代表签字盖章栏。",
    });
  }

  // Minefield 6: Expired Qualification / Certificate Dates
  const validityRegexes = [
    /有效期\s*(?:至|截止[至到]?)[：:\s]*(20\d{2}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?)/g,
    /有效期[：:\s]*20\d{2}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?\s*(?:至|-|—|~|到)\s*(20\d{2}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?)/g,
  ];

  for (const seg of segments) {
    for (const vre of validityRegexes) {
      for (const vm of seg.text.matchAll(vre)) {
        const expStr = vm[1];
        const expMs = parseChineseDateToUtcMs(expStr);
        if (expMs !== null && expMs < bidDateMs) {
          const daysExpired = Math.round((bidDateMs - expMs) / 86400000);
          issues.push({
            categoryId: "expired_qualification",
            code: "M6",
            severity: "fatal",
            title: `企业资质或体系认证证书在开标日（${bidDateStr}）前已过期`,
            location: seg.location,
            excerpt: seg.text,
            detail: `检测到证书截止日期为「${expStr}」，早于本次投标基准日（${bidDateStr}）已逾期 ${daysExpired} 天！提交过期《安全生产许可证》或 ISO 证书将直接导致资格审查废标。`,
            fixAction: "立即联系公司资质管理员替换最新延续换证后的扫描件及正文有效期文字。",
          });
        }
      }
    }
  }

  // Summary counts per minefield
  const summaryByCategory = MINEFIELD_CATEGORIES.map((cat) => {
    const count = issues.filter((i) => i.categoryId === cat.id).length;
    return {
      ...cat,
      count,
      status: count > 0 ? "danger" : "clean",
    };
  });

  const isPro = Boolean(options.isPro);
  const visibleIssues = isPro ? issues : issues.slice(0, FREE_PREVIEW_ISSUES);
  const hiddenCount = Math.max(0, issues.length - visibleIssues.length);

  // Risk score: 100 = clean pass, deduct per fatal/high finding
  const safetyScore = Math.max(0, 100 - issues.reduce((acc, item) => acc + (item.severity === "fatal" ? 18 : 10), 0));

  return {
    productSlug: PRODUCT_SLUG,
    bidDate: bidDateStr,
    segmentCount: segments.length,
    safetyScore,
    totalIssueCount: issues.length,
    fatalCount: issues.filter((i) => i.severity === "fatal").length,
    isPro,
    summaryByCategory,
    visibleIssues,
    hiddenCount,
    lockedCategoriesTeaser: isPro
      ? []
      : issues.slice(FREE_PREVIEW_ISSUES).map((item, idx) => ({
          index: FREE_PREVIEW_ISSUES + idx + 1,
          severity: item.severity,
          masked: true,
          label:
            item.severity === "fatal"
              ? "一票否决致命废标项（已脱敏锁定 · 解锁查看具体雷区与标书原句）"
              : "形式评审高危扣分项（已脱敏锁定 · 解锁查看具体雷区与标书原句）",
        })),
    allIssues: isPro ? issues : undefined,
  };
}

/**
 * Convert plain pasted / OCR tender text into structured segments so text-only
 * Coze / Alipay Tbox workflows share the exact same deterministic 6-minefield engine.
 */
export function parsePlainTextSegments(rawText) {
  const normalized = String(rawText || "").replace(/\r\n?/g, "\n");
  const lines = normalized
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return lines.map((text, idx) => {
    const isHeader = /^(?:页眉|Header)[：:\s]/i.test(text);
    const isFooter = /^(?:页脚|Footer)[：:\s]/i.test(text);
    return {
      source: isHeader ? "header" : isFooter ? "footer" : "paragraph",
      entryName: isHeader ? "plain/header" : isFooter ? "plain/footer" : "plain/text",
      location: isHeader
        ? `页眉文本 第 ${idx + 1} 行`
        : isFooter
          ? `页脚文本 第 ${idx + 1} 行`
          : `文本第 ${idx + 1} 段`,
      text,
    };
  });
}

const RUBRIC_STOPWORDS = new Set([
  "要求", "提供", "具备", "符合", "满足", "投标人", "响应", "不少于", "不低于",
  "不得", "需要", "应当", "必须", "文件", "内容", "相关", "进行", "以及", "承诺",
  "服务", "项目", "说明", "材料", "证明", "有效", "情况", "以上", "以内",
]);

function extractRubricAnchors(clauseText) {
  const cleaned = String(clauseText || "").replace(/^[★*▲●•\d.、()（）\s]+/, "").trim();
  const anchors = [];
  const seen = new Set();
  const push = (t) => {
    const val = String(t || "").trim();
    if (!val || seen.has(val) || RUBRIC_STOPWORDS.has(val)) return;
    seen.add(val);
    anchors.push(val);
  };

  // Priority 1: Explicit certifications / standards / numbers with units (ISO27001, 3年, 2小时, 7×24, 99.9%)
  const specMatches =
    cleaned.match(/(?:ISO\s*\d+|CMMI\s*\d|等保[二三四]级|7\s*[×xX*]\s*24|\d+(?:\.\d+)?\s*(?:个?日历天|工作日|小时|分钟|年|个月|万元|元|%|名|人|台|套))/gi) ||
    [];
  for (const m of specMatches) push(m.replace(/\s+/g, ""));

  // Priority 2: Quoted terms or key technical nouns
  const quoted = [...cleaned.matchAll(/[《「“"【]([^》」”"】]{2,20})[》」”"】]/g)].map((m) => m[1]);
  for (const q of quoted) push(q);

  // Priority 3: Meaningful Chinese/English core phrases split by punctuation
  const chunks = cleaned
    .split(/[，,。；;：:（）()、\s/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  for (const ch of chunks) {
    if (ch.length <= 8) {
      push(ch);
    } else {
      // Extract 2-4 char domain stems (e.g. 质保期、驻场响应、类似业绩、安全生产许可证、项目经理)
      const domainHits =
        ch.match(/(?:质保期?|保修期?|驻场|响应时间|售后服务|类似业绩|业绩合同|安全生?产?许可证|项目经理|社保|授权委托书|营业执照|财务审计|信用中国|无重大违法|违约责任|保密协议|应急预案|培训方案|验收标准|交货期|工期|付款方式)/g) ||
        [];
      for (const h of domainHits) push(h);
      if (domainHits.length === 0) {
        push(ch.slice(0, 4));
      }
    }
  }
  return anchors.slice(0, 6);
}

/**
 * M7: Cross-check mandatory ★ clauses & tender scoring rubric items against all bid segments.
 */
export function auditRubricCompliance(segments, rubricItems = []) {
  const rawList = Array.isArray(rubricItems)
    ? rubricItems
    : String(rubricItems || "")
        .split(/\r?\n|[；;]/)
        .map((s) => s.trim())
        .filter(Boolean);

  const items = rawList.map((s) => String(s || "").trim()).filter(Boolean);
  if (items.length === 0) {
    return {
      totalClauses: 0,
      matchedCount: 0,
      missingCount: 0,
      fatalMissingCount: 0,
      complianceRate: 100,
      results: [],
    };
  }

  const results = items.map((clause, idx) => {
    const isMandatoryStar = /^[★*▲]|实质性|一票否决|废标/.test(clause);
    const anchors = extractRubricAnchors(clause);
    let bestSeg = null;
    let bestHits = [];

    for (const seg of segments) {
      const compactSeg = seg.text.replace(/\s+/g, "").toLowerCase();
      const hits = anchors.filter((a) => compactSeg.includes(a.replace(/\s+/g, "").toLowerCase()));
      if (hits.length > bestHits.length) {
        bestHits = hits;
        bestSeg = seg;
      }
    }

    const requiredHits = anchors.length >= 3 ? 2 : 1;
    const matched = anchors.length > 0 && bestHits.length >= requiredHits;

    return {
      index: idx + 1,
      clause,
      isMandatoryStar,
      status: matched ? "matched" : "missing",
      severity: !matched && isMandatoryStar ? "fatal" : !matched ? "high" : "clean",
      anchorsChecked: anchors,
      matchedAnchors: bestHits,
      evidenceLocation: matched && bestSeg ? bestSeg.location : null,
      evidenceExcerpt: matched && bestSeg ? bestSeg.text.slice(0, 140) : null,
      fixAction: matched
        ? "已检测到对应响应段落，建议核对数值与招标要求完全一致并保留正偏离表述。"
        : isMandatoryStar
          ? "⚠️ 属于 ★ 实质性条款且未检出完整响应！请立即在《商务/技术偏离表》及正文对应章节逐字响应，否则开标直接废标。"
          : "未检出明显评分点响应，建议对照评标办法逐项补充证明材料与承诺段落避免失分。",
    };
  });

  const matchedCount = results.filter((r) => r.status === "matched").length;
  const missingCount = results.length - matchedCount;
  const fatalMissingCount = results.filter((r) => r.status === "missing" && r.isMandatoryStar).length;
  const complianceRate = Number(((matchedCount / results.length) * 100).toFixed(1));

  return {
    totalClauses: results.length,
    matchedCount,
    missingCount,
    fatalMissingCount,
    complianceRate,
    results,
  };
}

/**
 * End-to-end binary .docx auditor (Browser File/ArrayBuffer or Node Buffer -> full compliance report).
 */
export async function auditDocxBuffer(binaryInput, options = {}) {
  const extracted = await extractDocxXmlEntries(binaryInput, options);
  const segments = parseWordXmlSegments(extracted.xmlFiles);
  const audit = auditSegments(segments, options);
  const rubric = auditRubricCompliance(segments, options.rubricItems || []);
  return {
    ...audit,
    rubricAudit: rubric.totalClauses > 0 ? rubric : undefined,
    archiveEntryCount: extracted.entryCount,
    scannedXmlParts: Object.keys(extracted.xmlFiles),
  };
}

/**
 * End-to-end plain text / OCR tender auditor (for Coze / Alipay Tbox chat & OCR pipelines).
 */
export function auditPlainText(rawText, options = {}) {
  const segments = parsePlainTextSegments(rawText);
  const audit = auditSegments(segments, options);
  const rubric = auditRubricCompliance(segments, options.rubricItems || []);
  return {
    ...audit,
    rubricAudit: rubric.totalClauses > 0 ? rubric : undefined,
    archiveEntryCount: 0,
    scannedXmlParts: ["plain/text"],
  };
}

/**
 * Export the Pro Pre-Bid Zero-Defect Clearance Checklist (《开标前逐项清零核对单》).
 */
export function exportClearanceChecklist(report) {
  if (!report.isPro) {
    return {
      allowed: false,
      reason: "PRO_REQUIRED",
      markdown: "",
    };
  }

  const list = report.allIssues || report.visibleIssues || [];
  const lines = [
    `# 《开标前废标风险逐项清零核对单》（BidGuard 标书排雷王生成）`,
    ``,
    `- **核验基准开标日**：${report.bidDate}`,
    `- **扫描部件**：${(report.scannedXmlParts || ["word/document.xml"]).join(", ")}`,
    `- **安全健康分**：${report.safetyScore} / 100 · **检出风险总数**：${report.totalIssueCount} 项（其中一票否决致命项 ${report.fatalCount} 项）`,
    `- **隐私声明**：纯内存解析生成，标书全文零字节落盘留存。`,
    ``,
    `---`,
    ``,
    `## 一、六大废标雷区体检总览`,
    ...report.summaryByCategory.map(
      (c) => `- ${c.count > 0 ? "❌" : "✅"} **${c.code} ${c.zhLabel}**：${c.count > 0 ? `发现 ${c.count} 处隐患` : "核验通过"}`
    ),
    ``,
    `## 二、逐段排雷修改签字确认表`,
    ...(list.length === 0
      ? [`- [x] 未检出六大常规废标隐患，建议做最终封标前纸质骑缝章复核。`]
      : list.flatMap((item, idx) => [
          `### - [ ] 风险 #${idx + 1} [${item.code}] ${item.title}`,
          `- **精确定位**：\`${item.location}\``,
          `- **原文摘录**：> ${item.excerpt}`,
          `- **废标原因剖析**：${item.detail}`,
          `- **整改动作**：**${item.fixAction}**`,
          `- **复核人签字 / 时间**：__________________`,
          ``,
        ])),
  ];

  if (report.rubricAudit && report.rubricAudit.totalClauses > 0) {
    lines.push(`## 三、招标实质性条款（★）/ 评分细则核对表（响应率 ${report.rubricAudit.complianceRate}%）`);
    lines.push(``);
    for (const r of report.rubricAudit.results) {
      const badge = r.status === "matched" ? "✅ 已响应" : r.isMandatoryStar ? "🚨 漏答(★废标项)" : "❌ 疑似漏答";
      lines.push(`- ${badge} **条款 #${r.index}**：${r.clause}`);
      if (r.evidenceLocation) {
        lines.push(`  - 命中定位：\`${r.evidenceLocation}\` — ${r.evidenceExcerpt}`);
      } else {
        lines.push(`  - 整改建议：${r.fixAction}`);
      }
    }
    lines.push(``);
  }

  return {
    allowed: true,
    filename: `标书开标前清零核对单-${report.bidDate}.md`,
    markdown: lines.join("\n"),
  };
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function base64UrlToBytes(b64url) {
  const normalized = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (normalized.length % 4)) % 4;
  return base64ToBytes(normalized + "=".repeat(padLen));
}

/**
 * Verify an OPC1 Ed25519 activation license token (`p === "bid-docx-checker" || p === "*"`).
 */
export async function verifyLicenseToken(token, options = {}) {
  const {
    expectedProduct = PRODUCT_SLUG,
    publicSpkiBase64 = PUBLIC_SPKI_BASE64,
    nowSec = Math.floor(Date.now() / 1000),
  } = options;

  if (typeof token !== "string" || !token.trim()) {
    return { valid: false, reason: "EMPTY_TOKEN", message: "License token is empty" };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "OPC1" || !parts[1] || !parts[2]) {
    return { valid: false, reason: "BAD_FORMAT", message: "Expected OPC1.<payload>.<signature> format" };
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return { valid: false, reason: "NO_WEBCRYPTO", message: "WebCrypto SubtleCrypto is unavailable" };
  }

  try {
    const [, payloadB64, sigB64] = parts;
    const spkiBytes = base64ToBytes(publicSpkiBase64);
    const sigBytes = base64UrlToBytes(sigB64);
    const signedBytes = new TextEncoder().encode(`OPC1.${payloadB64}`);

    const key = await subtle.importKey(
      "spki",
      spkiBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );

    const verified = await subtle.verify("Ed25519", key, sigBytes, signedBytes);
    if (!verified) {
      return { valid: false, reason: "BAD_SIGNATURE", message: "Ed25519 signature verification failed" };
    }

    const payloadJson = new TextDecoder().decode(base64UrlToBytes(payloadB64));
    const payload = JSON.parse(payloadJson);

    if (expectedProduct && payload.p !== expectedProduct && payload.p !== "*") {
      return {
        valid: false,
        reason: "PRODUCT_MISMATCH",
        message: `Token is scoped to "${payload.p}", not "${expectedProduct}"`,
        payload,
      };
    }

    if (payload.exp && Number(payload.exp) > 0 && nowSec > Number(payload.exp)) {
      return {
        valid: false,
        reason: "EXPIRED",
        message: "Activation code has expired",
        payload,
      };
    }

    return { valid: true, payload };
  } catch (err) {
    return {
      valid: false,
      reason: "VERIFY_ERROR",
      message: err instanceof Error ? err.message : "Failed to verify license token",
    };
  }
}
