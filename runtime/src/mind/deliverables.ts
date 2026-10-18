// 交付物（issue #18）：把她写好的内容生成 Word / Excel / PowerPoint / PDF 文件，或直接写出 Markdown / HTML / CSV / JSON 文本报告。
//   不自己实现文件格式，用成熟的纯 JS 库（MIT，打进 main.cjs，不依赖原生模块，安卓 App 内置的运行环境同样能用）：
//     Markdown 解析 marked；Word docx；Excel exceljs；PowerPoint pptxgenjs；PDF pdfkit（字体见 deliverable-pdf.ts）。
//   这里只管「内容 → 文件字节」：放在哪里、闸门、附件交付在 deliverable-tools.ts。
//   内容的来源：Markdown（标题、段落、列表、表格、代码块、引用、图片）、结构化数据（工作表、幻灯片）或 CSV；
//   图片只收本地文件（核对文件头，挡住受保护的路径），网址不下载。
import fs from "node:fs";
import path from "node:path";
import { marked, type Token, type Tokens } from "marked";
import { sniffImage } from "./images.ts";
import { protectedPath } from "../sandbox.ts";

export const FORMATS = ["docx", "xlsx", "pptx", "pdf", "md", "html", "csv", "json"] as const;
export type Format = (typeof FORMATS)[number];
export const FORMAT_LABEL: Record<Format, string> = { docx: "Word 文档", xlsx: "Excel 工作簿", pptx: "PowerPoint 演示文稿", pdf: "PDF", md: "Markdown", html: "HTML 网页", csv: "CSV 表格", json: "JSON" };
export const MIME: Record<Format, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf", md: "text/markdown", html: "text/html", csv: "text/csv", json: "application/json",
};

export const MAX_TEXT = 500_000;     // Markdown / HTML / CSV 原文最多这么多字符（与一份 canvas 相同）
export const MAX_SHEETS = 50;
export const MAX_CELLS = 1_000_000;  // 一个工作簿合计
export const MAX_SLIDES = 200;
export const MAX_IMAGES = 50;
export const MAX_IMAGE_BYTES = 20 << 20;

export class DeliverableError extends Error { constructor(m: string) { super(m); this.name = "DeliverableError"; } }
const bad = (m: string): never => { throw new DeliverableError(m); };

// ---------- 输入
export type CellInput = string | number | boolean | null | { formula: string; result?: string | number } | { date: string } | { value: string | number | boolean | null; format?: string; bold?: boolean };
export interface ColumnInput { header?: string; width?: number; format?: string }
export interface SheetInput { name?: string; columns?: (ColumnInput | string)[]; rows?: CellInput[][]; csv?: string; freeze?: boolean }
export interface SlideInput { title?: string; subtitle?: string; bullets?: (string | { text: string; level?: number })[]; text?: string; image?: string; table?: { header?: string[]; rows: (string | number)[][] }; notes?: string }
export interface Spec {
  format: Format; title?: string; author?: string;
  markdown?: string; html?: string; csv?: string; data?: unknown;
  sheets?: SheetInput[]; slides?: SlideInput[];
}
/** 生成时的环境：baseDir 是相对路径（Markdown 里的图片）从哪里算；warnings 收集没做到的事（图片读不到等），交给她看。 */
export interface RenderCtx { baseDir: string; warnings: string[]; images: number }

// ---------- Markdown → 块
export interface Run { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; link?: string }
export type Block =
  | { t: "h"; level: number; runs: Run[] }
  | { t: "p"; runs: Run[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "table"; header: Run[][]; rows: Run[][][]; align: ("left" | "center" | "right" | null)[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "image"; src: string; alt: string }
  | { t: "hr" };

function inline(tokens: Token[] | undefined, style: Omit<Run, "text"> = {}, out: Run[] = [], images?: { src: string; alt: string }[]): Run[] {
  for (const tk of tokens ?? []) {
    switch (tk.type) {
      case "strong": inline((tk as Tokens.Strong).tokens, { ...style, bold: true }, out, images); break;
      case "em": inline((tk as Tokens.Em).tokens, { ...style, italic: true }, out, images); break;
      case "del": inline((tk as Tokens.Del).tokens, { ...style, strike: true }, out, images); break;
      case "codespan": out.push({ ...style, text: decodeEntities((tk as Tokens.Codespan).text), code: true }); break;
      case "link": inline((tk as Tokens.Link).tokens, { ...style, link: (tk as Tokens.Link).href }, out, images); break;
      case "image": if (images) images.push({ src: (tk as Tokens.Image).href, alt: (tk as Tokens.Image).text }); else out.push({ ...style, text: (tk as Tokens.Image).text }); break;
      case "br": out.push({ ...style, text: "\n" }); break;
      case "text": { const t = tk as Tokens.Text; if (t.tokens?.length) inline(t.tokens, style, out, images); else out.push({ ...style, text: decodeEntities(t.text) }); break; }
      case "escape": out.push({ ...style, text: decodeEntities((tk as Tokens.Escape).text) }); break;
      case "html": out.push({ ...style, text: (tk as Tokens.HTML).text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "") }); break;
      default: if ("text" in tk && typeof tk.text === "string") out.push({ ...style, text: decodeEntities(tk.text) });
    }
  }
  return out;
}
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decodeEntities = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENT[e]);

function blocks(tokens: Token[]): Block[] {
  const out: Block[] = [];
  for (const tk of tokens) {
    switch (tk.type) {
      case "heading": out.push({ t: "h", level: (tk as Tokens.Heading).depth, runs: inline((tk as Tokens.Heading).tokens) }); break;
      case "paragraph": case "text": {
        const images: { src: string; alt: string }[] = [];
        const runs = inline((tk as Tokens.Paragraph).tokens ?? [{ type: "text", raw: tk.raw, text: (tk as Tokens.Text).text } as Token], {}, [], images);
        if (runs.some((r) => r.text.trim())) out.push({ t: "p", runs });
        for (const im of images) out.push({ t: "image", ...im }); // 图片单独成块（Word、PDF、幻灯片里都占一整行）
        break;
      }
      case "list": {
        const l = tk as Tokens.List;
        out.push({ t: "list", ordered: l.ordered, start: typeof l.start === "number" ? l.start : 1, items: l.items.map((it) => {
          const b = blocks(it.tokens);
          if (it.task && b[0]?.t === "p") b[0].runs.unshift({ text: it.checked ? "☑ " : "☐ " });
          return b;
        }) });
        break;
      }
      case "table": {
        const t = tk as Tokens.Table;
        out.push({ t: "table", header: t.header.map((c) => inline(c.tokens)), rows: t.rows.map((r) => r.map((c) => inline(c.tokens))), align: t.align });
        break;
      }
      case "code": out.push({ t: "code", lang: (tk as Tokens.Code).lang ?? "", text: (tk as Tokens.Code).text }); break;
      case "blockquote": out.push({ t: "quote", blocks: blocks((tk as Tokens.Blockquote).tokens) }); break;
      case "hr": out.push({ t: "hr" }); break;
      case "html": { const s = (tk as Tokens.HTML).text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim(); if (s) out.push({ t: "p", runs: [{ text: decodeEntities(s) }] }); break; }
      default: break; // space、def 等
    }
  }
  return out;
}

/** Markdown → 块（GFM：表格、删除线、任务列表）。 */
export function parseMarkdown(md: string): Block[] {
  if (md.length > MAX_TEXT) bad(`内容太长（${md.length} 字符，最多 ${MAX_TEXT}）`);
  return blocks(marked.lexer(md, { gfm: true }));
}
export const runsText = (runs: Run[]) => runs.map((r) => r.text).join("");

/** 按单独一行的 --- 分页（幻灯片）；代码块里的 --- 不算。 */
export function splitSlides(md: string): string[] {
  const out: string[] = [];
  let cur: string[] = [], fence = "";
  for (const line of md.split(/\r?\n/)) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) fence = fence ? (f[1][0] === fence[0] && f[1].length >= fence.length ? "" : fence) : f[1];
    if (!fence && /^\s{0,3}-{3,}\s*$/.test(line)) { out.push(cur.join("\n")); cur = []; continue; }
    cur.push(line);
  }
  out.push(cur.join("\n"));
  return out.filter((s) => s.trim());
}

// ---------- 图片
export interface Img { data: Buffer; type: "png" | "jpg" | "gif" | "bmp"; width: number; height: number; mime: string }
/** 图片的像素尺寸（只读文件头）。 */
export function imageSize(b: Buffer, mime: string): { width: number; height: number } | undefined {
  try {
    if (mime === "image/png") return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mime === "image/gif") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (mime === "image/bmp") return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
    if (mime === "image/jpeg") {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* 文件头不完整 */ }
  return undefined;
}

/** 读一张本地图片（Markdown 与幻灯片引用的）：相对路径从 baseDir 算；受保护的路径、不是图片、太大、读不到都记进 warnings 并返回 undefined。 */
export function loadImg(src: string, ctx: RenderCtx, allow: Img["type"][] = ["png", "jpg", "gif", "bmp"]): Img | undefined {
  const s = src.trim().replace(/^<|>$/g, "");
  if (/^(https?|data|ftp):/i.test(s)) { ctx.warnings.push(`图片 ${s.slice(0, 80)} 是网址，没有下载（先用 shell 下载到工作区，再写本地路径）`); return undefined; }
  if (++ctx.images > MAX_IMAGES) { if (ctx.images === MAX_IMAGES + 1) ctx.warnings.push(`图片超过 ${MAX_IMAGES} 张，后面的没有放进去`); return undefined; }
  const p = path.resolve(ctx.baseDir, decodeURI(s.replace(/^file:\/\//, "")));
  const denied = protectedPath(p);
  if (denied) { ctx.warnings.push(`图片 ${s}：${denied}`); return undefined; }
  let data: Buffer;
  try { const st = fs.statSync(p); if (!st.isFile()) throw new Error("不是文件"); if (st.size > MAX_IMAGE_BYTES) throw new Error(`太大（最多 ${MAX_IMAGE_BYTES >> 20} MB）`); data = fs.readFileSync(p); }
  catch (e) { ctx.warnings.push(`图片 ${s} 读不到（${(e as Error).message.slice(0, 80)}）`); return undefined; }
  const mime = sniffImage(data.subarray(0, 32)) ?? "";
  const type = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/bmp": "bmp" } as Record<string, Img["type"]>)[mime];
  const size = type ? imageSize(data, mime) : undefined;
  if (!type || !allow.includes(type) || !size || size.width <= 0 || size.height <= 0) { ctx.warnings.push(`图片 ${s} 不是支持的格式（${allow.join(" / ")}）`); return undefined; }
  return { data, type, mime, ...size };
}
/** 按最大宽高等比缩放。 */
export const fit = (w: number, h: number, maxW: number, maxH: number) => { const k = Math.min(1, maxW / w, maxH / h); return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }; };

// ---------- CSV
/** RFC 4180 的 CSV（含引号、引号里的逗号与换行）；首行有制表符而没有逗号时按 TSV。 */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const first = s.slice(0, s.indexOf("\n") >= 0 ? s.indexOf("\n") : s.length);
  const sep = first.includes("\t") && !first.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"' && cell === "") q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const csvCell = (v: unknown) => { const s = v === null || v === undefined ? "" : typeof v === "object" ? String((v as any).formula ? `=${(v as any).formula}` : (v as any).date ?? (v as any).value ?? "") : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

// ---------- Word
async function renderDocx(spec: Spec, ctx: RenderCtx): Promise<Buffer> {
  const d = await import("docx");
  const md = spec.markdown ?? "";
  const children: (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] = [];
  let listInstance = 0;
  const HEAD = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];
  const textRuns = (runs: Run[], extra: { bold?: boolean } = {}): import("docx").ParagraphChild[] => runs.flatMap((r): import("docx").ParagraphChild[] => {
    const parts = r.text.split("\n");
    const mk = (t: string, i: number) => new d.TextRun({ text: t, break: i > 0 ? 1 : undefined, bold: r.bold || extra.bold, italics: r.italic, strike: r.strike, font: r.code ? "Consolas" : undefined, shading: r.code ? { type: d.ShadingType.CLEAR, color: "auto", fill: "EEEEEE" } : undefined, style: r.link ? "Hyperlink" : undefined });
    const runs2 = parts.map(mk);
    return r.link && /^(https?:|mailto:)/i.test(r.link) ? [new d.ExternalHyperlink({ link: r.link, children: runs2 })] : runs2;
  });
  const image = (b: Extract<Block, { t: "image" }>) => {
    const img = loadImg(b.src, ctx);
    if (!img) return new d.Paragraph({ children: [new d.TextRun({ text: `［图片：${b.alt || b.src}］`, italics: true, color: "888888" })] });
    const sz = fit(img.width, img.height, 600, 800); // 页面正文约 6.3 英寸（96 dpi 下 600 像素）
    return new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.ImageRun({ type: img.type, data: img.data, transformation: sz, altText: { name: b.alt || "image", description: b.alt || "", title: b.alt || "" } })] });
  };
  const emit = (list: Block[], indent = 0, quote = false) => {
    for (const b of list) {
      const ind = indent || quote ? { left: indent * 360 + (quote ? 360 : 0) } : undefined;
      switch (b.t) {
        case "h": children.push(new d.Paragraph({ heading: HEAD[b.level - 1], children: textRuns(b.runs) })); break;
        case "p": children.push(new d.Paragraph({ children: textRuns(b.runs), indent: ind, border: quote ? { left: { style: d.BorderStyle.SINGLE, size: 12, color: "BBBBBB", space: 8 } } : undefined })); break;
        case "image": children.push(image(b)); break;
        case "hr": children.push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "BBBBBB", space: 1 } }, children: [] })); break;
        case "code":
          for (const line of b.text.split("\n")) children.push(new d.Paragraph({ spacing: { before: 0, after: 0 }, indent: ind, shading: { type: d.ShadingType.CLEAR, color: "auto", fill: "F3F3F3" }, children: [new d.TextRun({ text: line || " ", font: "Consolas", size: 19 })] }));
          children.push(new d.Paragraph({ children: [] }));
          break;
        case "quote": emit(b.blocks, indent, true); break;
        case "list": {
          const inst = ++listInstance;
          for (const item of b.items) { // 有序列表一律从 1 起编（每个列表一个编号实例，彼此不接续）
            const [head, ...rest] = item;
            const runs = head && head.t === "p" ? head.runs : [];
            const marker = b.ordered ? { numbering: { reference: "ol", level: Math.min(8, indent), instance: inst } } : { bullet: { level: Math.min(8, indent) } };
            children.push(new d.Paragraph({ ...marker, children: textRuns(runs) }));
            emit(head && head.t === "p" ? rest : item, indent + 1, quote);
          }
          break;
        }
        case "table": {
          const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
          const cell = (runs: Run[] | undefined, head: boolean, col: number) => new d.TableCell({
            shading: head ? { type: d.ShadingType.CLEAR, color: "auto", fill: "E8E8E8" } : undefined,
            children: [new d.Paragraph({ alignment: b.align[col] === "center" ? d.AlignmentType.CENTER : b.align[col] === "right" ? d.AlignmentType.RIGHT : undefined, children: textRuns(runs ?? [], { bold: head }) })],
          });
          const rows = [new d.TableRow({ tableHeader: true, children: Array.from({ length: cols }, (_, c) => cell(b.header[c], true, c)) }), ...b.rows.map((r) => new d.TableRow({ children: Array.from({ length: cols }, (_, c) => cell(r[c], false, c)) }))];
          children.push(new d.Table({ rows, width: { size: 100, type: d.WidthType.PERCENTAGE } }));
          children.push(new d.Paragraph({ children: [] }));
          break;
        }
      }
    }
  };
  if (spec.title && !/^\s*#\s/.test(md)) children.push(new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: [new d.TextRun(spec.title)] }));
  emit(parseMarkdown(md));
  const levels = Array.from({ length: 9 }, (_, level) => ({ level, format: d.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: d.AlignmentType.START, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 360 } } } }));
  const doc = new d.Document({
    creator: spec.author || "Quetzal", title: spec.title ?? "", description: "",
    styles: { default: { document: { run: { font: { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft YaHei" }, size: 22 } } } },
    numbering: { config: [{ reference: "ol", levels }] },
    sections: [{ children: children.length ? children : [new d.Paragraph({ children: [] })] }],
  });
  return Buffer.from(await d.Packer.toBuffer(doc));
}

// ---------- Excel
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const NUMERIC = /^[+-]?(?:\d{1,15}(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** 显示宽度：中日韩等宽字符算 2。 */
const displayWidth = (s: string) => [...s].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
function toDate(s: string): Date | undefined {
  const m = s.match(ISO_DATE);
  if (!m) return undefined;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)); // 按墙上时间写进表格（Excel 的日期没有时区）
  return Number.isNaN(t) || new Date(t).getUTCDate() !== +m[3] ? undefined : new Date(t);
}
export interface Cell { value: unknown; format?: string; bold?: boolean; shown: string }
/** 一个单元格：数字、布尔照写；「=」开头是公式；ISO 日期写成日期；CSV 来的数字串写成数字（以 0 开头的编号除外）。 */
export function cellOf(v: CellInput | undefined, fromCsv = false): Cell {
  if (v === null || v === undefined || v === "") return { value: null, shown: "" };
  if (typeof v === "number") return Number.isFinite(v) ? { value: v, shown: String(v) } : { value: String(v), shown: String(v) };
  if (typeof v === "boolean") return { value: v, shown: String(v) };
  if (typeof v === "string") {
    if (v.length > 1 && v.startsWith("=")) return { value: { formula: v.slice(1) }, shown: v };
    const dt = toDate(v.trim());
    if (dt) return { value: dt, format: v.trim().length > 10 ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd", shown: v.trim() };
    if (fromCsv && NUMERIC.test(v.trim()) && !/^[+-]?0\d/.test(v.trim())) return { value: Number(v.trim()), shown: v.trim() };
    return { value: v.length > 32767 ? v.slice(0, 32767) : v, shown: v };
  }
  if (typeof v === "object") {
    if ("formula" in v && typeof v.formula === "string") { const f = v.formula.replace(/^=/, ""); return { value: v.result !== undefined ? { formula: f, result: v.result } : { formula: f }, shown: `=${f}` }; }
    if ("date" in v && typeof v.date === "string") { const dt = toDate(v.date.trim()); return dt ? { value: dt, format: v.date.trim().length > 10 ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd", shown: v.date } : { value: v.date, shown: v.date }; }
    if ("value" in v) { const c = cellOf(v.value as CellInput, fromCsv); return { ...c, format: typeof v.format === "string" ? v.format : c.format, bold: v.bold === true }; }
  }
  return { value: String(v), shown: String(v) };
}

/** 工作表名：Excel 不收 \ / ? * : [ ]，最长 31 个字符，不能重名。 */
export function sheetName(name: string | undefined, i: number, used: Set<string>): string {
  let n = String(name ?? "").replace(/[\\/?*:[\]]/g, "_").replace(/^'+|'+$/g, "").trim().slice(0, 31) || `Sheet${i + 1}`;
  for (let k = 2; used.has(n.toLowerCase()); k++) n = `${n.slice(0, 31 - String(k).length - 1)}_${k}`;
  used.add(n.toLowerCase());
  return n;
}

/** 工作表输入整理成表头 + 行（CSV 的第一行当表头）。 */
export function sheetRows(s: SheetInput): { columns: ColumnInput[]; rows: Cell[][]; header: boolean } {
  const columns = (s.columns ?? []).map((c) => (typeof c === "string" ? { header: c } : c ?? {}));
  if (typeof s.csv === "string") {
    if (s.csv.length > MAX_TEXT) bad(`CSV 太长（${s.csv.length} 字符，最多 ${MAX_TEXT}）`);
    const raw = parseCsv(s.csv);
    const head = columns.length ? undefined : raw.shift();
    return { columns: columns.length ? columns : (head ?? []).map((h) => ({ header: h })), rows: raw.map((r) => r.map((v) => cellOf(v, true))), header: true };
  }
  if (!Array.isArray(s.rows) && !columns.length) bad("工作表要给 rows（二维数组）、csv 或 columns");
  const rows = (s.rows ?? []).map((r, i) => Array.isArray(r) ? r.map((v) => cellOf(v)) : bad(`第 ${i + 1} 行不是数组`));
  return { columns, rows, header: columns.some((c) => c.header !== undefined) };
}

async function renderXlsx(spec: Spec): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const sheets = spec.sheets?.length ? spec.sheets : typeof spec.csv === "string" ? [{ name: spec.title, csv: spec.csv }] : bad("Excel 要给 sheets（工作表数组）或 csv");
  if (sheets.length > MAX_SHEETS) bad(`工作表太多（${sheets.length}，最多 ${MAX_SHEETS}）`);
  const wb = new ExcelJS.Workbook();
  wb.creator = spec.author || "Quetzal"; wb.title = spec.title ?? ""; wb.created = new Date();
  const used = new Set<string>();
  let cells = 0;
  for (const [i, s] of sheets.entries()) {
    const { columns, rows, header } = sheetRows(s);
    cells += rows.reduce((n, r) => n + r.length, 0);
    if (cells > MAX_CELLS) bad(`单元格太多（最多 ${MAX_CELLS} 个）`);
    const ws = wb.addWorksheet(sheetName(s.name, i, used), header && s.freeze !== false ? { views: [{ state: "frozen", ySplit: 1 }] } : undefined);
    const width = Math.max(columns.length, ...rows.map((r) => r.length), 0);
    if (header) {
      const hr = ws.addRow(Array.from({ length: width }, (_, c) => columns[c]?.header ?? ""));
      hr.font = { bold: true };
      hr.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E8E8" } }; c.border = { bottom: { style: "thin", color: { argb: "FF999999" } } }; });
    }
    for (const r of rows) {
      const row = ws.addRow(r.map((c) => c.value));
      r.forEach((c, k) => { const cell = row.getCell(k + 1); const f = c.format ?? columns[k]?.format; if (f) cell.numFmt = f; if (c.bold) cell.font = { bold: true }; });
    }
    for (let c = 0; c < width; c++) { // 列宽：给了就用，否则按内容估（中文算两个字宽）
      const given = columns[c]?.width;
      const est = Math.max(displayWidth(String(columns[c]?.header ?? "")), ...rows.slice(0, 500).map((r) => displayWidth(r[c]?.shown ?? "")), 4);
      ws.getColumn(c + 1).width = typeof given === "number" && given > 0 ? Math.min(255, given) : Math.min(60, est + 2);
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- PowerPoint
/** 幻灯片：结构化的 slides，或 Markdown（单独一行的 --- 分页；每页第一个标题是这页的标题，列表是要点，表格、图片照放，「备注：」开头的段落进演讲者备注）。 */
export function slidesFromMarkdown(md: string): SlideInput[] {
  return splitSlides(md).map((part) => {
    const s: SlideInput & { extra?: Block[] } = {};
    const rest: Block[] = [];
    for (const b of parseMarkdown(part)) {
      if (b.t === "h" && s.title === undefined) { s.title = runsText(b.runs); continue; }
      if (b.t === "h" && s.subtitle === undefined && !rest.length && !s.bullets) { s.subtitle = runsText(b.runs); continue; }
      if (b.t === "p" && /^(备注|notes?)[:：]/i.test(runsText(b.runs).trim())) { s.notes = [s.notes, runsText(b.runs).trim().replace(/^(备注|notes?)[:：]\s*/i, "")].filter(Boolean).join("\n"); continue; }
      if (b.t === "list") { const flat = (l: Extract<Block, { t: "list" }>, level: number): { text: string; level: number }[] => l.items.flatMap((it) => it.flatMap((x) => x.t === "list" ? flat(x, level + 1) : x.t === "p" ? [{ text: runsText(x.runs), level }] : [])); s.bullets = [...(s.bullets ?? []), ...flat(b, 0)]; continue; }
      if (b.t === "image" && !s.image) { s.image = b.src; continue; }
      if (b.t === "table" && !s.table) { s.table = { header: b.header.map(runsText), rows: b.rows.map((r) => r.map(runsText)) }; continue; }
      if (b.t === "quote") { rest.push(...b.blocks); continue; }
      rest.push(b);
    }
    const text = rest.map((b) => b.t === "p" ? runsText(b.runs) : b.t === "code" ? b.text : b.t === "h" ? runsText(b.runs) : "").filter(Boolean).join("\n");
    if (text) s.text = text;
    return s;
  });
}

type PptxCtor = new () => import("pptxgenjs").default;
async function renderPptx(spec: Spec, ctx: RenderCtx): Promise<Buffer> {
  const m = await import("pptxgenjs") as unknown as { default: PptxCtor | { default: PptxCtor } };
  const Pptx: PptxCtor = "default" in m.default ? m.default.default : m.default; // CommonJS 与 ES 模块两种加载方式下 default 的层次不同
  const slides = spec.slides?.length ? spec.slides : typeof spec.markdown === "string" && spec.markdown.trim() ? slidesFromMarkdown(spec.markdown) : bad("演示文稿要给 slides（幻灯片数组）或 markdown（单独一行的 --- 分页）");
  if (slides.length > MAX_SLIDES) bad(`幻灯片太多（${slides.length}，最多 ${MAX_SLIDES}）`);
  const p = new Pptx();
  p.layout = "LAYOUT_WIDE"; // 13.33 × 7.5 英寸（16:9）
  p.title = spec.title ?? ""; p.author = spec.author || "Quetzal"; p.company = "";
  const FONT = "Microsoft YaHei", W = 13.33, M = 0.6;
  for (const [i, s] of slides.entries()) {
    if (!s || typeof s !== "object") bad(`第 ${i + 1} 张幻灯片不是对象`);
    const slide = p.addSlide();
    const bullets = (s.bullets ?? []).map((b) => typeof b === "string" ? { text: b, level: 0 } : { text: String(b?.text ?? ""), level: Math.max(0, Math.min(4, Number(b?.level) || 0)) });
    const lone = !bullets.length && !s.text && !s.image && !s.table; // 只有标题（与副标题）：封面式排版
    let y = M;
    if (s.title) {
      slide.addText(String(s.title), { x: M, y: lone ? 2.4 : y, w: W - 2 * M, h: lone ? 1.4 : 0.9, fontSize: lone ? 40 : 28, bold: true, fontFace: FONT, color: "222222", align: lone ? "center" : "left", valign: "middle" });
      y += 1.0;
    }
    if (s.subtitle) { slide.addText(String(s.subtitle), { x: M, y: lone ? 3.9 : y, w: W - 2 * M, h: 0.7, fontSize: lone ? 22 : 18, fontFace: FONT, color: "666666", align: lone ? "center" : "left" }); y += 0.8; }
    const img = s.image ? loadImg(String(s.image), ctx, ["png", "jpg", "gif"]) : undefined;
    const bodyH = 7.5 - y - 0.4;
    const side = img && (bullets.length || s.text || s.table) ? (W - 2 * M) / 2 : 0; // 有文字时图片放右半边
    const textW = side ? side - 0.2 : W - 2 * M;
    let ty = y;
    if (bullets.length) {
      const h = Math.min(bodyH - (s.table ? 2 : 0), 0.45 * bullets.length + 0.3);
      slide.addText(bullets.map((b) => ({ text: b.text, options: { bullet: true, indentLevel: b.level, breakLine: true } })), { x: M, y: ty, w: textW, h, fontSize: bullets.length > 8 ? 16 : 20, fontFace: FONT, color: "333333", valign: "top", fit: "shrink" });
      ty += h + 0.1;
    }
    if (s.text) {
      const h = Math.max(0.6, Math.min(bodyH - (ty - y) - (s.table ? 2 : 0), 0.4 * Math.ceil(String(s.text).length / 40) + 0.4));
      slide.addText(String(s.text), { x: M, y: ty, w: textW, h, fontSize: 16, fontFace: FONT, color: "444444", valign: "top", fit: "shrink" });
      ty += h + 0.1;
    }
    if (s.table && Array.isArray(s.table.rows)) {
      const head = (s.table.header ?? []).map((t) => ({ text: String(t ?? ""), options: { bold: true, fill: { color: "E8E8E8" } } }));
      const rows = s.table.rows.slice(0, 60).map((r) => (Array.isArray(r) ? r : [r]).map((t) => ({ text: String(t ?? "") })));
      slide.addTable([...(head.length ? [head] : []), ...rows], { x: M, y: ty, w: textW, fontSize: rows.length > 12 ? 10 : 12, fontFace: FONT, border: { type: "solid", pt: 0.5, color: "BBBBBB" }, autoPage: false });
      if (s.table.rows.length > 60) ctx.warnings.push(`第 ${i + 1} 张幻灯片的表格超过 60 行，只放了前 60 行`);
    }
    if (img) {
      const boxW = side ? side - 0.2 : W - 2 * M, boxH = bodyH;
      const k = Math.min(boxW / img.width, boxH / img.height);
      const w = img.width * k, h = img.height * k;
      slide.addImage({ data: `${img.mime};base64,${img.data.toString("base64")}`, x: (side ? M + side + 0.2 : M) + (boxW - w) / 2, y: y + (boxH - h) / 2, w, h });
    }
    if (s.notes) slide.addNotes(String(s.notes));
  }
  return Buffer.from(await p.write({ outputType: "nodebuffer" }) as ArrayBuffer);
}

// ---------- 文本报告
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export function renderHtml(spec: Spec): string {
  if (typeof spec.html === "string") {
    if (spec.html.length > MAX_TEXT) bad(`HTML 太长（${spec.html.length} 字符，最多 ${MAX_TEXT}）`);
    if (/^\s*(<!doctype|<html)/i.test(spec.html)) return spec.html;
  }
  const body = typeof spec.html === "string" ? spec.html : marked.parse(spec.markdown ?? "", { gfm: true, async: false }) as string;
  const title = spec.title ?? spec.markdown?.match(/^#\s+(.+)$/m)?.[1] ?? "";
  return `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc(title)}</title>\n<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;line-height:1.7;max-width:860px;margin:2em auto;padding:0 1em;color:#222}
table{border-collapse:collapse;margin:1em 0}th,td{border:1px solid #ccc;padding:.4em .7em}th{background:#f0f0f0}
pre{background:#f5f5f5;padding:.8em;overflow:auto;border-radius:4px}code{font-family:Consolas,Menlo,monospace}
blockquote{border-left:4px solid #ccc;margin-left:0;padding-left:1em;color:#555}img{max-width:100%}
@media (prefers-color-scheme:dark){body{background:#1e1e1e;color:#ddd}th{background:#333}pre{background:#2a2a2a}td,th{border-color:#555}}
</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

/** 生成文件的字节。PDF 在 deliverable-pdf.ts（字体探测）。 */
export async function render(spec: Spec, ctx: RenderCtx): Promise<Buffer> {
  switch (spec.format) {
    case "docx": return renderDocx(spec, ctx);
    case "xlsx": return renderXlsx(spec);
    case "pptx": return renderPptx(spec, ctx);
    case "pdf": return (await import("./deliverable-pdf.ts")).renderPdf(spec, ctx);
    case "md": { const s = spec.markdown ?? bad("Markdown 要给 markdown"); if (s.length > MAX_TEXT) bad(`内容太长（最多 ${MAX_TEXT} 字符）`); return Buffer.from(s.endsWith("\n") ? s : `${s}\n`, "utf8"); }
    case "html": return Buffer.from(renderHtml(spec), "utf8");
    case "csv": {
      let s: string;
      if (typeof spec.csv === "string") s = spec.csv;
      else if (spec.sheets?.length) { const { columns, rows, header } = sheetRows(spec.sheets[0]); s = toCsv([...(header ? [columns.map((c) => c.header ?? "")] : []), ...rows.map((r) => r.map((c) => c.shown))]); }
      else return bad("CSV 要给 csv 或 sheets");
      if (s.length > MAX_TEXT) bad(`CSV 太长（最多 ${MAX_TEXT} 字符）`);
      return Buffer.from(`﻿${s.replace(/^﻿/, "")}`, "utf8"); // 带 BOM：Excel 直接打开时中文不乱码
    }
    case "json": {
      const v = spec.data !== undefined ? spec.data : typeof spec.markdown === "string" ? (() => { try { return JSON.parse(spec.markdown!); } catch (e) { return bad(`不是合法的 JSON：${(e as Error).message}`); } })() : bad("JSON 要给 data");
      const s = JSON.stringify(v, null, 2);
      if (s.length > MAX_TEXT * 4) bad("JSON 太大");
      return Buffer.from(`${s}\n`, "utf8");
    }
  }
}
