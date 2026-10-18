// 文档读取：把常见文档抽成纯文本，供 read_document 工具分页读取。不引入依赖：
//   OOXML（docx / pptx / xlsx）与 ODF（odt / ods / odp）、EPUB 都是 zip + XML，用内置的 zlib 解压后抽取文字；
//   HTML、RTF、各类文本直接处理；PDF 优先用 pdftotext（poppler），没有时退回简易解析（未压缩或 Flate 压缩的文字；字体带 ToUnicode 时按它还原中文）；
//   旧版二进制 doc / xls / ppt 交给 antiword / catdoc / xls2csv / catppt 等命令（没有安装时给出提示）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { run } from "../sh.ts";

export const PAGE_CHARS = 20_000;

// ---------- zip
/** 读取 zip 的全部条目（只支持存储与 deflate，足够应付 Office / ODF / EPUB）。 */
export function unzip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("不是有效的 zip 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, () => Buffer>();
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : Buffer.alloc(0);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------- XML / HTML
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", middot: "·", hellip: "…", mdash: "—", ndash: "–", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’" };
export const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
const tidy = (s: string) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

export function htmlToText(html: string) {
  return decode(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** 通用的 XML 抽文字：rules 把段落、单元格等结束标签换成换行或分隔符，其余标签去掉。 */
function xmlText(xml: string, rules: [RegExp, string][]) {
  let s = xml;
  for (const [re, to] of rules) s = s.replace(re, to);
  return tidy(decode(s.replace(/<[^>]+>/g, "")));
}
const num = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);

function docx(z: Map<string, () => Buffer>) {
  const parts = ["word/document.xml", ...[...z.keys()].filter((k) => /^word\/(footnotes|endnotes)\.xml$/.test(k))];
  // 单元格里的段落用空格连接（否则表格读出来每格一行，看不出哪格是哪格）
  const cells = (x: string) => x.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (c) => c.replace(/<\/w:p>(?![\s\S]*<\/w:p>)/, "").replace(/<\/w:p>/g, " "));
  return parts.filter((k) => z.has(k)).map((k) => xmlText(cells(z.get(k)!().toString("utf8")), [
    [/<w:tab\/>/g, "\t"], [/<w:br[^>]*\/>/g, "\n"], [/<\/w:p>/g, "\n"], [/<\/w:tc>/g, " | "], [/<\/w:tr>/g, "\n"],
  ])).join("\n\n");
}

function pptx(z: Map<string, () => Buffer>) {
  const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b));
  return slides.map((k) => {
    const text = xmlText(z.get(k)!().toString("utf8"), [[/<\/a:p>/g, "\n"], [/<a:br\/>/g, "\n"]]);
    const notesKey = `ppt/notesSlides/notesSlide${num(k)}.xml`;
    const notes = z.has(notesKey) ? xmlText(z.get(notesKey)!().toString("utf8"), [[/<\/a:p>/g, "\n"]]).replace(/^\d+$/m, "").trim() : "";
    return `--- 第 ${num(k)} 页 ---\n${text}${notes ? `\n（备注）${notes}` : ""}`;
  }).join("\n\n");
}

const colIndex = (ref: string) => [...(ref.match(/^[A-Z]+/)?.[0] ?? "A")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** styles.xml 里哪些单元格样式（cellXfs 的序号）是日期格式：内置的 14–22、45–47，或格式串里有年月日时（引号里的不算）。 */
function dateStyles(z: Map<string, () => Buffer>): Set<number> {
  const out = new Set<number>();
  if (!z.has("xl/styles.xml")) return out;
  const xml = z.get("xl/styles.xml")!().toString("utf8");
  const custom = new Map([...xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), decode(m[2])]));
  const isDate = (id: number) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (custom.has(id) && /[ymdhs]/i.test(custom.get(id)!.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "")));
  const xfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  [...xfs.matchAll(/<xf\b([^>]*?)\/?>/g)].forEach((m, i) => { if (isDate(Number(m[1].match(/numFmtId="(\d+)"/)?.[1] ?? 0))) out.add(i); });
  return out;
}
/** Excel 的日期序号（1900 日期系统）→ 当地墙上时间的 ISO 写法。 */
function serialDate(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const ms = Math.round((n - 25569) * 86_400_000), d = new Date(ms).toISOString();
  return n % 1 === 0 ? d.slice(0, 10) : d.slice(0, 16).replace("T", " ");
}

function xlsx(z: Map<string, () => Buffer>) {
  const dates = dateStyles(z);
  const shared = z.has("xl/sharedStrings.xml")
    ? [...z.get("xl/sharedStrings.xml")!().toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "").replace(/<[^>]+>/g, "")))
    : [];
  const wb = z.has("xl/workbook.xml") ? z.get("xl/workbook.xml")!().toString("utf8") : "";
  const names = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => decode(m[1]));
  const sheets = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b));
  return sheets.map((k, i) => {
    const rows = [...z.get(k)!().toString("utf8").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
      const cells: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] ?? "";
        const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1] ?? "", type = attrs.match(/\bt="(\w+)"/)?.[1];
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1], f = body.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
        const style = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? -1);
        const val = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? decode((body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? ""))
          : v === undefined && f !== undefined ? `=${decode(f)}` // 只有公式、没有缓存结果（没在 Excel 里打开算过）：给出公式本身
          : type !== "str" && type !== "b" && type !== "e" && v !== undefined && dates.has(style) ? serialDate(Number(v)) : decode(v ?? "");
        cells[ref ? colIndex(ref) : cells.length] = val;
      }
      return Array.from(cells, (x) => x ?? "").join("\t");
    }).filter((r) => r.trim());
    return `--- 工作表：${names[i] ?? `Sheet${i + 1}`}（${rows.length} 行，制表符分隔）---\n${rows.join("\n")}`;
  }).join("\n\n");
}

function odf(z: Map<string, () => Buffer>) {
  if (!z.has("content.xml")) throw new Error("缺少 content.xml");
  return xmlText(z.get("content.xml")!().toString("utf8"), [
    [/<text:tab\/>/g, "\t"], [/<text:s\/>/g, " "], [/<text:line-break\/>/g, "\n"], [/<\/text:(p|h)>/g, "\n"],
    [/<\/table:table-cell>/g, "\t"], [/<\/table:table-row>/g, "\n"], [/<draw:page\b[^>]*draw:name="([^"]*)"[^>]*>/g, "\n--- $1 ---\n"],
  ]);
}

function epub(z: Map<string, () => Buffer>) {
  const opfKey = [...z.keys()].find((k) => k.endsWith(".opf"));
  let order = [...z.keys()].filter((k) => /\.x?html?$/i.test(k));
  if (opfKey) { // 按 spine 顺序
    const opf = z.get(opfKey)!().toString("utf8"), base = path.posix.dirname(opfKey);
    const hrefs = Object.fromEntries([...opf.matchAll(/<item\b[^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)].map((m) => [m[1], path.posix.join(base === "." ? "" : base, decodeURIComponent(m[2]))]));
    const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => hrefs[m[1]]).filter((k) => k && z.has(k));
    if (spine.length) order = spine;
  }
  return order.map((k) => htmlToText(z.get(k)!().toString("utf8"))).filter(Boolean).join("\n\n");
}

function rtf(s: string) {
  return tidy(s.replace(/\\par[d]?/g, "\n").replace(/\{\\\*[^{}]*\}/g, "").replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((Number(n) + 65536) % 65536)).replace(/\\[a-z]+-?\d* ?/gi, "").replace(/[{}]/g, ""));
}

/** ToUnicode CMap：字符码 → 文字（bfchar 与 bfrange 两种写法，bfrange 的目标可以是起点或数组）。bytes：字符码的字节数（取自 codespacerange）。 */
export interface CMap { bytes: number; map: Map<number, string> }
export function parseCMap(text: string): CMap {
  const map = new Map<number, string>();
  const utf16 = (h: string) => { const b = Buffer.from(h.replace(/\s+/g, "").padEnd(Math.ceil(h.replace(/\s+/g, "").length / 4) * 4, "0"), "hex"); let s = ""; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i)); return s; };
  const space = text.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/);
  const bytes = space ? Math.max(1, Math.ceil(space[1].length / 2)) : 2;
  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), utf16(m[2]));
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16), hi = Math.min(parseInt(m[2], 16), lo + 65535);
      if (m[3] !== undefined) { const base = utf16(m[3]); if (!base) continue; for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo))); }
      else [...(m[4] ?? "").matchAll(/<([0-9a-fA-F]*)>/g)].forEach((d, i) => { if (lo + i <= hi) map.set(lo + i, utf16(d[1])); });
    }
  return { bytes, map };
}

/**
 * 没有 pdftotext 时的简易解析：解压 Flate 流，取出 Tj / TJ / ' / " 里的文字。字体带 ToUnicode（CMap）时按它把字符码换成文字——
 * 嵌入了子集字体的中文 PDF 都是这样（deliverable_create 生成的也是），安卓上没有 pdftotext 也读得回来；没有 ToUnicode 的按单字节字面取，复杂编码的可能取不到。
 */
export function pdfFallback(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const objs = new Map<number, string>();
  for (const m of raw.matchAll(/(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g)) objs.set(Number(m[1]), m[2]);
  const dictOf = (body: string) => { const i = body.indexOf("stream"); return i >= 0 ? body.slice(0, i) : body; };
  const streamOf = (body: string): string | undefined => {
    const m = body.match(/stream\r?\n([\s\S]*?)endstream/);
    if (!m) return undefined;
    if (!/\/FlateDecode/.test(dictOf(body))) return /\/Filter/.test(dictOf(body)) ? undefined : m[1];
    try { return zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { try { return zlib.inflateSync(Buffer.from(m[1].replace(/\r?\n$/, ""), "latin1")).toString("latin1"); } catch { return undefined; } }
  };
  // 字体对象 → ToUnicode；资源里的字体名（/F1）→ 字体对象
  const cmapOf = new Map<number, CMap>();
  for (const [n, body] of objs) {
    const t = dictOf(body).match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    const s = t && objs.has(Number(t[1])) ? streamOf(objs.get(Number(t[1]))!) : undefined;
    if (s) cmapOf.set(n, parseCMap(s));
  }
  const fonts = new Map<string, CMap>();
  for (const body of objs.values()) for (const d of dictOf(body).matchAll(/\/Font\s*<<([\s\S]*?)>>/g))
    for (const m of d[1].matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) { const c = cmapOf.get(Number(m[2])); if (c && !fonts.has(m[1])) fonts.set(m[1], c); }
  const literal = (x: string) => x.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) => /^[0-7]/.test(c) ? String.fromCharCode(parseInt(c, 8)) : ({ n: "\n", r: "", t: "\t", b: "", f: "" } as Record<string, string>)[c] ?? c);
  const text = (tok: string, cmap?: CMap) => {
    const bytes = tok.startsWith("<") ? Buffer.from(tok.slice(1, -1).replace(/\s+/g, "").replace(/^(.(..)*)$/, "$10"), "hex") : Buffer.from(literal(tok.slice(1, -1)), "latin1");
    if (!cmap) return bytes.toString("latin1");
    let out = "";
    for (let i = 0; i + cmap.bytes <= bytes.length; i += cmap.bytes) { let code = 0; for (let k = 0; k < cmap.bytes; k++) code = code * 256 + bytes[i + k]; out += cmap.map.get(code) ?? ""; }
    return out;
  };
  // 换行：T*、' "、纵向移动的 Td / TD，或文字矩阵 Tm 换到了另一条基线；同一条基线上隔得远的两段（表格的两格）之间补一个空格
  const OP = /\/([^\s/[\]()<>{}%]+)\s+(-?[\d.]+)\s+Tf|\((?:\\[\s\S]|[^\\)])*\)|<[0-9a-fA-F\s]*>|-?[\d.]+\s+(-?[\d.]+)\s+T[dD]\b|(?:-?[\d.]+\s+){4}(-?[\d.]+)\s+(-?[\d.]+)\s+Tm\b|T\*|\bTJ\b|\bTj\b|'|"/g;
  const out: string[] = [];
  for (const body of objs.values()) {
    const d = dictOf(body);
    if (/\/Subtype\s*\/(Image|CIDFontType0C|Type1C|OpenType|XML)|\/FontFile|\/Length1|\/Type\s*\/(XRef|ObjStm|Metadata)/.test(d)) continue; // 图片、字体、元数据不是正文
    const s = streamOf(body);
    if (!s || !/\b(Tj|TJ)\b|'|"/.test(s) || !/\bBT\b/.test(s)) continue;
    let font: CMap | undefined, size = 12, line = "", pending = "", y: number | undefined, end = 0;
    const lines: string[] = [];
    const brk = () => { if (line) lines.push(line); line = ""; };
    for (const m of s.matchAll(OP)) {
      const t = m[0];
      if (m[1] !== undefined) { font = fonts.get(m[1]); size = Math.abs(Number(m[2])) || size; }
      else if (t[0] === "(" || t[0] === "<") pending += text(t, font);
      else if (t === "Tj" || t === "TJ") { line += pending; end += [...pending].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 1 : 0.55), 0) * size; pending = ""; }
      else if (t === "'" || t === '"') { brk(); line = pending; pending = ""; }
      else if (m[4] !== undefined) { // Tm：x y
        const nx = Number(m[4]), ny = Number(m[5]);
        if (y === undefined || Math.abs(ny - y) > size * 0.6) brk(); else if (line && nx - end > size * 1.5) line += " "; // 同一行里换了字体（行内代码）基线会差一点
        y = ny; end = nx;
      }
      else if (t === "T*" || (m[3] !== undefined && Number(m[3]) !== 0)) brk();
    }
    brk();
    if (lines.length) out.push(lines.join("\n"));
  }
  return tidy(out.join("\n"));
}

async function viaCommand(cmds: [string, string[]][], hint: string) {
  for (const [cmd, args] of cmds) {
    const r = await run(cmd, args, 60_000);
    if (r.code === 0 && r.out.trim()) return r.out;
  }
  throw new Error(hint);
}

/** 抽取文档全文。 */
export async function extractText(file: string): Promise<{ kind: string; text: string }> {
  const e = path.extname(file).slice(1).toLowerCase();
  const buf = fs.readFileSync(file);
  const zipped = () => unzip(buf);
  switch (e) {
    case "docx": case "docm": case "dotx": return { kind: "Word", text: docx(zipped()) };
    case "pptx": case "pptm": case "ppsx": return { kind: "PowerPoint", text: pptx(zipped()) };
    case "xlsx": case "xlsm": return { kind: "Excel", text: xlsx(zipped()) };
    case "odt": case "ods": case "odp": case "odg": return { kind: "OpenDocument", text: odf(zipped()) };
    case "epub": return { kind: "EPUB", text: epub(zipped()) };
    case "html": case "htm": case "xhtml": return { kind: "HTML", text: htmlToText(buf.toString("utf8")) };
    case "rtf": return { kind: "RTF", text: rtf(buf.toString("latin1")) };
    case "pdf": {
      try { return { kind: "PDF", text: await viaCommand([["pdftotext", ["-layout", "-enc", "UTF-8", file, "-"]]], "") }; }
      catch {
        const text = pdfFallback(buf);
        return { kind: "PDF", text: text ? `（未安装 pdftotext，以下为简易解析，可能不完整；安装 poppler 后效果更好）\n${text}` : "（未安装 pdftotext，简易解析也没有取出文字：可能是扫描件或使用了复杂字体编码。可以安装 poppler 后重试，例如 Termux 上 pkg install poppler）" };
      }
    }
    case "doc": return { kind: "Word 97-2003", text: await viaCommand([["antiword", [file]], ["catdoc", [file]]], "旧版 .doc 需要 antiword 或 catdoc（Termux：pkg install antiword），或先转换为 docx") };
    case "xls": return { kind: "Excel 97-2003", text: await viaCommand([["xls2csv", [file]]], "旧版 .xls 需要 xls2csv（catdoc 软件包），或先转换为 xlsx") };
    case "ppt": return { kind: "PowerPoint 97-2003", text: await viaCommand([["catppt", [file]]], "旧版 .ppt 需要 catppt（catdoc 软件包），或先转换为 pptx") };
    default: {
      if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) { // 未知的 zip：列出内容
        const z = zipped();
        return { kind: "ZIP 压缩包", text: `压缩包内共 ${z.size} 个条目：\n${[...z.keys()].slice(0, 500).join("\n")}` };
      }
      if (buf.subarray(0, 8192).includes(0)) throw new Error(`无法识别的二进制格式（.${e || "无扩展名"}），可以用 shell 命令（file、strings 等）处理`);
      return { kind: "文本", text: buf.toString("utf8") };
    }
  }
}

/** 分页读取：每次最多 PAGE_CHARS 字，提示下一页的 offset。 */
export async function readDocument(file: string, offset = 0): Promise<string> {
  const f = file.replace(/^file:\/\//, "");
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return `没有这个文件：${f}`;
  const { kind, text } = await extractText(f);
  const start = Math.max(0, Math.floor(offset) || 0), end = Math.min(text.length, start + PAGE_CHARS);
  const more = end < text.length ? `\n\n……（还有 ${text.length - end} 字，用 offset=${end} 继续读）` : "";
  return `【${path.basename(f)}】${kind}，共 ${text.length} 字，本次 ${start}–${end}\n\n${text.slice(start, end)}${more}`;
}
