// 交付物的 PDF：Markdown → PDF（pdfkit，MIT）。中文要能显示，PDF 必须嵌入一款含中文字形的字体：
//   不内置字体（一款够用的中文字体子集也要几 MB，会让每具身体的运行基座都变大），而是探测这具身体上已有的：
//   环境变量 QUETZAL_PDF_FONT（一个 .ttf / .otf / .ttc 文件）→ QUETZAL_HOME/fonts/ 里放的 → 各平台常见的系统中文字体
//   （安卓与多数 Linux 发行版的 Noto Sans CJK、文泉驿、Droid Sans Fallback；Windows 的微软雅黑、宋体、黑体；macOS 的苹方、黑体、冬青黑体）
//   → 有 fc-list 时问 fontconfig。都找不到时：内容里没有中日韩文字就用找到的西文字体，否则如实说明并给出办法（不出一份满是方块的 PDF）。
//   pdfkit 的 14 种标准字体在打包后的 main.cjs 里读不到（它从自己的目录读 AFM 文件），所以一律嵌入找到的字体，从不使用标准字体。
//   ttc 字体集按 PostScript 名挑一款（简体中文优先），名字从文件的 name 表读出，不需要另外的库。粗体：有同一家族的粗体文件就用，否则描边加粗。
import fs from "node:fs";
import path from "node:path";
import { paths } from "../config.ts";
import { execFileSync } from "node:child_process";
import { isWindows, which, hidden } from "../platform.ts";
import { parseMarkdown, runsText, loadImg, fit, DeliverableError, type Spec, type RenderCtx, type Block, type Run } from "./deliverables.ts";

export interface FontFace { file: string; family?: string } // family：字体集（.ttc）里的那一款的 PostScript 名
export interface PdfFonts { body: FontFace; bold?: FontFace; mono?: FontFace; cjk: boolean; source: string }

// ---------- 读字体文件的 PostScript 名（name 表 nameID 6）
function readAt(fd: number, pos: number, len: number): Buffer { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; }
function psNameAt(fd: number, off: number): string | undefined {
  const head = readAt(fd, off, 12), n = head.readUInt16BE(4);
  if (n > 200) return undefined;
  const dir = readAt(fd, off + 12, 16 * n);
  for (let i = 0; i < n; i++) {
    if (dir.toString("latin1", i * 16, i * 16 + 4) !== "name") continue;
    const at = dir.readUInt32BE(i * 16 + 8), len = Math.min(dir.readUInt32BE(i * 16 + 12), 1 << 20);
    const t = readAt(fd, at, len), count = t.readUInt16BE(2), strings = t.readUInt16BE(4);
    let mac: string | undefined;
    for (let r = 0; r < count && 6 + r * 12 + 12 <= t.length; r++) {
      const p = 6 + r * 12, platform = t.readUInt16BE(p), id = t.readUInt16BE(p + 6), l = t.readUInt16BE(p + 8), o = strings + t.readUInt16BE(p + 10);
      if (id !== 6 || o + l > t.length) continue;
      if (platform === 3 || platform === 0) { const s = t.subarray(o, o + l); let out = ""; for (let k = 0; k + 1 < s.length; k += 2) out += String.fromCharCode(s.readUInt16BE(k)); return out; }
      if (platform === 1) mac ??= t.toString("latin1", o, o + l);
    }
    return mac;
  }
  return undefined;
}
/** 一个字体文件里各款的 PostScript 名（.ttc 有多款；.ttf / .otf 一款）。读不了返回空。 */
export function fontNames(file: string): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const h = readAt(fd, 0, 12);
    if (h.toString("latin1", 0, 4) === "ttcf") {
      const n = Math.min(h.readUInt32BE(8), 64), offs = readAt(fd, 12, 4 * n);
      return Array.from({ length: n }, (_, i) => psNameAt(fd!, offs.readUInt32BE(i * 4)) ?? "").filter(Boolean);
    }
    const tag = h.readUInt32BE(0);
    if (tag !== 0x00010000 && h.toString("latin1", 0, 4) !== "OTTO" && h.toString("latin1", 0, 4) !== "true") return [];
    const name = psNameAt(fd, 0);
    return name ? [name] : [];
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
/** 字体集里挑一款：简体中文优先，其次繁体 / 日文 / 韩文以外的第一款。 */
function pick(names: string[], weight: "Regular" | "Bold"): string | undefined {
  const w = names.filter((n) => weight === "Bold" ? /bold/i.test(n) : !/bold|light|thin|black|medium|heavy|semi|extra|demi/i.test(n));
  const pool = w.length ? w : names;
  return pool.find((n) => /sc\b|sc-|gb|hans|cn|yahei(?!ui)|simsun|simhei|pingfangsc|stheiti|hiraginosansgb/i.test(n)) ?? pool.find((n) => !/jp|kr|tc|hk|ui/i.test(n)) ?? pool[0];
}
const face = (file: string, weight: "Regular" | "Bold" = "Regular"): FontFace | undefined => {
  const names = fontNames(file);
  if (!names.length) return undefined;
  return names.length > 1 ? { file, family: pick(names, weight) } : { file };
};

// ---------- 候选（平台级的常见位置，不针对具体机型）
const WIN_FONTS = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
const CJK_CANDIDATES = (): [string, string?][] => [ // [正文, 粗体]
  ...(isWindows ? [["msyh.ttc", "msyhbd.ttc"], ["msyh.ttf", "msyhbd.ttf"], ["Deng.ttf", "Dengb.ttf"], ["simhei.ttf"], ["simsun.ttc"]].map(([a, b]) => [path.join(WIN_FONTS, a), b && path.join(WIN_FONTS, b)] as [string, string?]) : []),
  ["/system/fonts/NotoSansCJK-Regular.ttc", "/system/fonts/NotoSansCJK-Bold.ttc"], // 安卓
  ["/system/fonts/NotoSansSC-Regular.otf", "/system/fonts/NotoSansSC-Bold.otf"],
  ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"], // Debian / Ubuntu
  ["/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc"], // Arch
  ["/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc", "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc"], // Fedora
  ["/usr/share/fonts/google-noto-sans-cjk-fonts/NotoSansCJK-Regular.ttc", "/usr/share/fonts/google-noto-sans-cjk-fonts/NotoSansCJK-Bold.ttc"],
  ["/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc"],
  ["/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"], ["/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"], ["/usr/share/fonts/wenquanyi/wqy-microhei/wqy-microhei.ttc"],
  ["/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf"], ["/system/fonts/DroidSansFallback.ttf"],
  ["/System/Library/Fonts/PingFang.ttc"], ["/System/Library/Fonts/STHeiti Medium.ttc"], ["/System/Library/Fonts/STHeiti Light.ttc"], ["/System/Library/Fonts/Hiragino Sans GB.ttc"], // macOS
  ["/System/Library/Fonts/Supplemental/Songti.ttc"], ["/Library/Fonts/Arial Unicode.ttf"], ["/System/Library/Fonts/Supplemental/Arial Unicode.ttf"],
  ...(process.env.PREFIX ? [[path.join(process.env.PREFIX, "share/fonts/noto-cjk/NotoSansCJK-Regular.ttc")] as [string]] : []), // Termux
];
const LATIN_CANDIDATES = () => [
  ...(isWindows ? ["arial.ttf", "segoeui.ttf"].map((f) => path.join(WIN_FONTS, f)) : []),
  "/system/fonts/Roboto-Regular.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf",
];
const MONO_CANDIDATES = () => [
  ...(isWindows ? ["consola.ttf", "cour.ttf"].map((f) => path.join(WIN_FONTS, f)) : []),
  "/system/fonts/DroidSansMono.ttf", "/system/fonts/CutiveMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
  "/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf", "/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf",
];
const exists = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const FONT_FILE = /\.(ttf|otf|ttc)$/i;

/** fontconfig 报告的中文字体（有 fc-list 时）。 */
function fcCjk(): string[] {
  try {
    const fc = which("fc-list");
    if (!fc) return [];
    const out = execFileSync(fc, [":lang=zh", "file"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], ...hidden });
    return [...new Set(out.split("\n").map((l) => l.replace(/:\s*$/, "").trim()).filter((f) => FONT_FILE.test(f)))].sort((a, b) => Number(/bold|light|thin|black|medium|heavy|serif/i.test(a)) - Number(/bold|light|thin|black|medium|heavy|serif/i.test(b)));
  } catch { return []; }
}

let cached: { at: number; fonts: PdfFonts | undefined } | undefined;
/** 探测 PDF 用的字体（结果缓存 10 分钟：装了新字体不用重启）。needCjk：内容里有中日韩文字。 */
export function pdfFonts(needCjk = true): PdfFonts | undefined {
  if (!cached || Date.now() - cached.at > 600_000) cached = { at: Date.now(), fonts: detect() };
  const f = cached.fonts;
  if (f && (f.cjk || !needCjk)) return f;
  return needCjk ? undefined : f;
}
export const resetPdfFonts = () => { cached = undefined; };

function detect(): PdfFonts | undefined {
  const mono = MONO_CANDIDATES().find(exists);
  const monoFace = mono ? face(mono) : undefined;
  const user = process.env.QUETZAL_PDF_FONT;
  if (user && exists(user)) { const f = face(user); if (f) return { body: f, mono: monoFace, cjk: true, source: `环境变量 QUETZAL_PDF_FONT（${user}）` }; }
  const own = path.join(paths.home, "fonts");
  try {
    const files = fs.readdirSync(own).filter((n) => FONT_FILE.test(n)).sort((a, b) => Number(/bold/i.test(a)) - Number(/bold/i.test(b)));
    const reg = files.find((n) => !/bold/i.test(n)) ?? files[0];
    if (reg) { const f = face(path.join(own, reg)); const b = files.find((n) => /bold/i.test(n)); if (f) return { body: f, bold: b ? face(path.join(own, b), "Bold") : undefined, mono: monoFace, cjk: true, source: `QUETZAL_HOME/fonts/${reg}` }; }
  } catch { /* 没有这个目录 */ }
  for (const [reg, bold] of CJK_CANDIDATES()) {
    if (!exists(reg)) continue;
    const f = face(reg);
    if (f) return { body: f, bold: bold && exists(bold) ? face(bold, "Bold") : undefined, mono: monoFace, cjk: true, source: reg };
  }
  for (const reg of fcCjk()) { const f = face(reg); if (f) return { body: f, mono: monoFace, cjk: true, source: `fontconfig（${reg}）` }; }
  const latin = LATIN_CANDIDATES().find(exists);
  const lf = latin ? face(latin) : undefined;
  return lf ? { body: lf, mono: monoFace, cjk: false, source: latin! } : monoFace ? { body: monoFace, cjk: false, source: mono! } : undefined;
}

export const NO_CJK_FONT = "这具身体上没有找到中文字体，PDF 里的中文会显示成方块，所以没有生成。办法：装一款中文字体（Debian / Ubuntu：sudo apt install fonts-noto-cjk；Fedora：sudo dnf install google-noto-sans-cjk-fonts；Arch：sudo pacman -S noto-fonts-cjk），或把一个 .ttf / .otf / .ttc 中文字体文件放进 QUETZAL_HOME/fonts/（也可以用环境变量 QUETZAL_PDF_FONT 指定），然后再生成；也可以先生成 Word（docx），由打开它的设备用自己的字体显示。";
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

// ---------- 排版
const A4 = { w: 595.28, h: 841.89 }, MARGIN = 56;
const SIZE = { body: 11, h: [22, 18, 15, 13, 12, 11], code: 9.5 };

export async function renderPdf(spec: Spec, ctx: RenderCtx): Promise<Buffer> {
  const md = spec.markdown ?? "";
  const needCjk = CJK.test(md) || CJK.test(spec.title ?? "");
  const fonts = pdfFonts(needCjk);
  if (!fonts) throw new DeliverableError(needCjk ? NO_CJK_FONT : "这具身体上没有找到可以嵌入 PDF 的字体（.ttf / .otf / .ttc）。把一个字体文件放进 QUETZAL_HOME/fonts/ 后再生成，或改生成 Word（docx）。");
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A4", margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN }, bufferPages: true, autoFirstPage: true, font: null as unknown as string, // 不加载标准字体（打包后读不到）
    info: { Title: spec.title ?? "", Author: spec.author || "Quetzal", Creator: "Quetzal" }, lang: "zh-CN", displayTitle: !!spec.title } as PDFKit.PDFDocumentOptions);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => { doc.on("end", () => res(Buffer.concat(chunks))); doc.on("error", rej); });
  doc.registerFont("body", fonts.body.file, fonts.body.family);
  if (fonts.bold) doc.registerFont("bold", fonts.bold.file, fonts.bold.family);
  if (fonts.mono) doc.registerFont("mono", fonts.mono.file, fonts.mono.family);
  doc.font("body");
  const left = MARGIN, width = A4.w - 2 * MARGIN, bottom = A4.h - MARGIN;
  const room = (h: number) => { if (doc.y + h > bottom) doc.addPage(); };
  const monoOk = (s: string) => !!fonts.mono && !/[^\x00-\xff]/.test(s);

  /** 一段带格式的文字（粗体用粗体字体，没有就描边加粗；行内代码用等宽字体与灰底不便，改为等宽字体 + 深红色）。 */
  const runs = (rs: Run[], o: { x: number; w: number; size: number; color?: string; bold?: boolean; align?: "left" | "center" | "right" }) => {
    const list = rs.filter((r) => r.text);
    if (!list.length) { doc.moveDown(0.3); return; }
    doc.x = o.x;
    list.forEach((r, i) => {
      const bold = r.bold || o.bold;
      doc.font(r.code && monoOk(r.text) ? "mono" : bold && fonts.bold ? "bold" : "body").fontSize(r.code ? o.size * 0.92 : o.size)
        .fillColor(r.link ? "#1a5fb4" : r.code ? "#a51d2d" : o.color ?? "#222222").strokeColor(o.color ?? "#222222").lineWidth(0.35);
      const opts: PDFKit.Mixins.TextOptions = { width: o.w, continued: i < list.length - 1, lineGap: 3, align: o.align, underline: !!r.link, strike: !!r.strike, oblique: r.italic ? 10 : undefined, link: r.link && /^(https?:|mailto:)/i.test(r.link) ? r.link : undefined, ...(bold && !fonts.bold ? { stroke: true, fill: true } : {}) } as PDFKit.Mixins.TextOptions;
      if (i === 0) doc.text(r.text, o.x, doc.y, opts); else doc.text(r.text, opts);
    });
    doc.font("body").fillColor("#222222");
  };

  const table = (b: Extract<Block, { t: "table" }>, x: number, w: number) => {
    const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length), 1);
    // 列宽：按每列内容的长度分配，每列至少 1/(2×列数)
    const len = Array.from({ length: cols }, (_, c) => Math.min(40, Math.max(2, ...[b.header, ...b.rows].map((r) => runsText(r[c] ?? []).length))));
    const total = len.reduce((a, n) => a + n, 0), minW = w / (2 * cols);
    let cw = len.map((n) => Math.max(minW, (w * n) / total));
    const k = w / cw.reduce((a, n) => a + n, 0); cw = cw.map((n) => n * k);
    const pad = 4, size = cols > 5 ? 8.5 : 9.5;
    const height = (row: Run[][], head: boolean) => Math.max(...Array.from({ length: cols }, (_, c) => { doc.font(head && fonts.bold ? "bold" : "body").fontSize(size); return doc.heightOfString(runsText(row[c] ?? []) || " ", { width: cw[c] - 2 * pad, lineGap: 2 }); })) + 2 * pad;
    const draw = (row: Run[][], head: boolean) => {
      const h = height(row, head);
      if (doc.y + h > bottom) { doc.addPage(); if (!head) draw(b.header, true); }
      const y = doc.y;
      let cx = x;
      for (let c = 0; c < cols; c++) {
        if (head) doc.rect(cx, y, cw[c], h).fill("#e8e8e8");
        doc.rect(cx, y, cw[c], h).lineWidth(0.5).strokeColor("#999999").stroke();
        doc.font(head && fonts.bold ? "bold" : "body").fontSize(size).fillColor("#222222");
        doc.text(runsText(row[c] ?? []), cx + pad, y + pad, { width: cw[c] - 2 * pad, lineGap: 2, align: b.align[c] ?? "left", ...(head && !fonts.bold ? { stroke: true, fill: true } : {}) } as PDFKit.Mixins.TextOptions);
        cx += cw[c];
      }
      doc.x = x; doc.y = y + h;
    };
    if (b.header.some((c) => runsText(c).trim())) draw(b.header, true);
    for (const r of b.rows) draw(r, false);
    doc.moveDown(0.6);
  };

  const emit = (list: Block[], x: number, w: number, quote = false) => {
    for (const b of list) {
      const color = quote ? "#555555" : undefined;
      switch (b.t) {
        case "h": { const s = SIZE.h[b.level - 1]; room(s * 2.2); doc.moveDown(b.level <= 2 ? 0.6 : 0.4); runs(b.runs, { x, w, size: s, bold: true, color }); doc.moveDown(0.3); break; }
        case "p": room(SIZE.body * 2); runs(b.runs, { x, w, size: SIZE.body, color }); doc.moveDown(0.5); break;
        case "hr": room(12); doc.moveTo(x, doc.y + 4).lineTo(x + w, doc.y + 4).lineWidth(0.5).strokeColor("#bbbbbb").stroke(); doc.y += 12; break;
        case "image": {
          const img = loadImg(b.src, ctx, ["png", "jpg"]);
          if (!img) { runs([{ text: `［图片：${b.alt || b.src}］`, italic: true }], { x, w, size: SIZE.body, color: "#888888" }); doc.moveDown(0.5); break; }
          const sz = fit(img.width, img.height, w, bottom - MARGIN - 20);
          room(sz.height + 8);
          doc.image(img.data, x + (w - sz.width) / 2, doc.y, { width: sz.width, height: sz.height });
          doc.x = x; doc.y += sz.height + 8;
          if (b.alt) { runs([{ text: b.alt }], { x, w, size: 9, color: "#666666", align: "center" }); doc.moveDown(0.4); }
          break;
        }
        case "code": {
          const mono = monoOk(b.text);
          doc.font(mono ? "mono" : "body").fontSize(SIZE.code);
          doc.moveDown(0.2);
          for (const line of b.text.replace(/\t/g, "    ").split("\n")) {
            const h = doc.heightOfString(line || " ", { width: w - 16, lineGap: 1.5 }) + 1;
            room(h + 2);
            const y = doc.y;
            doc.rect(x, y, w, h + 2).fill("#f3f3f3");
            doc.font(mono ? "mono" : "body").fontSize(SIZE.code).fillColor("#333333").text(line || " ", x + 8, y + 1, { width: w - 16, lineGap: 1.5 });
            doc.x = x; doc.y = y + h + 2;
          }
          doc.moveDown(0.6);
          break;
        }
        case "quote": {
          const y0 = doc.y, p0 = doc.bufferedPageRange().start + doc.bufferedPageRange().count;
          emit(b.blocks, x + 14, w - 14, true);
          const p1 = doc.bufferedPageRange().start + doc.bufferedPageRange().count;
          if (p0 === p1) doc.moveTo(x + 3, y0).lineTo(x + 3, doc.y - 6).lineWidth(2).strokeColor("#cccccc").stroke(); // 跨页的引用不画竖线
          break;
        }
        case "list": {
          b.items.forEach((item, i) => {
            const marker = b.ordered ? `${b.start + i}.` : "•";
            const ind = b.ordered ? 22 : 14;
            const [head, ...rest] = item;
            room(SIZE.body * 2);
            const y = doc.y;
            doc.font("body").fontSize(SIZE.body).fillColor(color ?? "#222222").text(marker, x, y, { width: ind, lineBreak: false });
            doc.y = y;
            if (head?.t === "p") { runs(head.runs, { x: x + ind, w: w - ind, size: SIZE.body, color }); doc.moveDown(0.2); emit(rest, x + ind, w - ind, quote); }
            else emit(item, x + ind, w - ind, quote);
          });
          doc.x = x; doc.moveDown(0.3);
          break;
        }
        case "table": table(b, x, w); break;
      }
    }
  };
  if (spec.title && !/^\s*#\s/.test(md)) { runs([{ text: spec.title }], { x: left, w: width, size: 24, bold: true }); doc.moveDown(0.8); }
  emit(parseMarkdown(md), left, width);
  // 页码：第 n / N 页（页脚，在下边距里）
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const m = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font("body").fontSize(8).fillColor("#888888").text(`${i + 1} / ${range.count}`, left, A4.h - MARGIN / 2 - 4, { width, align: "center", lineBreak: false });
    doc.page.margins.bottom = m;
  }
  if (!fonts.cjk && needCjk) ctx.warnings.push(NO_CJK_FONT);
  ctx.warnings.push(`PDF 字体：${fonts.source}${fonts.bold ? "（含粗体）" : "（粗体为描边加粗）"}`);
  doc.end();
  return done;
}
