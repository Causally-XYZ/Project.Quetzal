// 交付物（#18）：每种格式生成后用 read_document 的解析读回核对（中文、表格、多工作表、多页幻灯片、PDF 的中文与分页）；
//   文件名与放置（只写进工作区 / 交付目录、不覆盖、符号链接）；工具层与闸门（类别、拒绝、覆盖送审、审计）；
//   附件交付（随回复入库、醒来时随 send_message 发出、飞书据此取文件）与网关的轻量预览。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import http from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-deliverables-"));
process.env.QUETZAL_HOME = path.join(tmp, "home");
process.env.QUETZAL_DELIVERABLES_DIR = path.join(tmp, "out");
const { loadConfig, saveConfig, config } = await import("../src/config.ts");
loadConfig();
saveConfig({ brain: { memoryLearning: false, memorySemantic: false } } as never);
const store = await import("../src/store.ts");
store.openStore();
const d = await import("../src/mind/deliverables.ts");
const pdf = await import("../src/mind/deliverable-pdf.ts");
const dt = await import("../src/mind/deliverable-tools.ts");
const docs = await import("../src/mind/documents.ts");
const att = await import("../src/mind/attachments.ts");
const { callTool, allTools } = await import("../src/mind/tools.ts");
const { Session } = await import("../src/mind/activity.ts");
const guard = await import("../src/guard/guard.ts");
const sentinel = await import("../src/guard/sentinel.ts");
const ws = await import("../src/mind/workspace.ts");
const cv = await import("../src/mind/canvas.ts");
const { bus } = await import("../src/bus.ts");
const reg = await import("../src/providers/registry.ts");
const { converse } = await import("../src/mind/brain.ts");
const { REMOTE_CORE_TOOLS } = await import("../src/mind/bodies.ts");
const { limbTools } = await import("../src/mind/tools.ts");

let server: http.Server | undefined;
after(() => { server?.close(); store.db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const work = fs.mkdtempSync(path.join(tmp, "work-"));
const ctx = () => ({ baseDir: work, warnings: [] as string[], images: 0 });
const write = (name: string, b: Buffer) => { const f = path.join(work, name); fs.writeFileSync(f, b); return f; };
const read = async (f: string) => (await docs.extractText(f)).text;
const entries = (f: string) => [...docs.unzip(fs.readFileSync(f)).keys()];
const entry = (f: string, name: string) => docs.unzip(fs.readFileSync(f)).get(name)!().toString("utf8");

/** 一张 w×h 的 PNG（真的能解码：IHDR + 未压缩的扫描行 + CRC）。 */
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "latin1"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(work, "图.png"), png(40, 20));

const MD = [
  "# 季度报告", "", "这是**中文**段落，含 `行内代码` 与 [链接](https://example.com)。", "",
  "- 第一点", "- 第二点", "  1. 子项甲", "  2. 子项乙", "",
  "| 项目 | 金额 |", "|---|---:|", "| 收入 | 1200 |", "| 支出 | 800 |", "",
  "```python", "print('你好')", "```", "", "> 引用的一句话", "", "![示意图](图.png)", "",
].join("\n");

test("Markdown 解析：块、行内格式、单独成块的图片、幻灯片分页不切代码块", () => {
  const b = d.parseMarkdown(MD);
  assert.deepEqual(b.map((x) => x.t), ["h", "p", "list", "table", "code", "quote", "image"]);
  const p = b[1] as Extract<typeof b[number], { t: "p" }>;
  assert.ok(p.runs.some((r) => r.bold && r.text === "中文") && p.runs.some((r) => r.code) && p.runs.some((r) => r.link === "https://example.com"));
  const parts = d.splitSlides("# 一\n---\n```\n---\n```\n---\n# 三");
  assert.equal(parts.length, 3, "代码块里的 --- 不分页");
  assert.equal(parts[1], "```\n---\n```");
  assert.equal(d.splitSlides("# 一\n\n---\n\n# 二\n\n---\n\n# 三").length, 3);
});

test("Word：中文、标题、列表、表格、代码块、图片，读回来内容一致", async () => {
  const c = ctx();
  const f = write("r.docx", await d.render({ format: "docx", title: "季度报告", markdown: MD }, c));
  assert.deepEqual(c.warnings, []);
  const text = await read(f);
  for (const s of ["季度报告", "这是中文段落，含 行内代码 与 链接。", "第一点", "子项乙", "收入 | 1200", "支出 | 800", "print('你好')", "引用的一句话"]) assert.ok(text.includes(s), `缺少：${s}\n${text}`);
  assert.ok(entries(f).some((n) => /^word\/media\/.+\.png$/.test(n)), "图片嵌进了文档");
  assert.match(entry(f, "word/document.xml"), /<w:tbl>/);
  assert.match(entry(f, "docProps/core.xml"), /季度报告/, "标题写进文件属性");
});

test("Excel：多个工作表、表头、数字、日期、公式、列宽与格式、CSV 工作表，读回来内容一致", async () => {
  const f = write("r.xlsx", await d.render({ format: "xlsx", title: "账本", sheets: [
    { name: "收入", columns: [{ header: "日期" }, { header: "金额", format: "#,##0.00", width: 14 }, "备注"], rows: [["2026-10-01", 12.5, "咖啡"], ["2026-10-02T14:30", 30, null], ["合计", "=SUM(B2:B3)", { value: "加粗", bold: true }]] },
    { name: "收入", csv: "名字,数量,编号\n苹果,3,007\n\"香蕉, 进口\",12.5,010\n" }, // 重名的工作表另起名字
    { name: "a/b:c", rows: [[1, true], [{ formula: "A1*2", result: 2 }, { date: "2026-01-31" }]] },
  ] }, ctx()));
  const text = await read(f);
  assert.match(text, /工作表：收入（4 行/);
  assert.match(text, /日期\t金额\t备注\n2026-10-01\t12\.5\t咖啡\n2026-10-02 14:30\t30\n合计\t=SUM\(B2:B3\)\t加粗/, text);
  assert.match(text, /工作表：收入_2（3 行[\s\S]*名字\t数量\t编号\n苹果\t3\t007\n香蕉, 进口\t12\.5\t010/, "CSV：引号里的逗号、以 0 开头的编号保留为文字");
  assert.match(text, /工作表：a_b_c（2 行[\s\S]*1\t1\n2\t2026-01-31/, "非法字符换掉；有缓存结果的公式读出结果");
  const s1 = entry(f, "xl/worksheets/sheet1.xml");
  assert.match(s1, /<f>SUM\(B2:B3\)<\/f>/);
  assert.match(s1, /<pane[^>]*ySplit="1"[^>]*state="frozen"/, "冻结表头");
  assert.match(s1, /<col min="2" max="2" width="14"/, "给定的列宽");
  assert.match(entry(f, "xl/styles.xml"), /#,##0\.00|numFmtId="4"/);
  assert.equal(d.cellOf("=A1").shown, "=A1");
  assert.equal(d.cellOf("123", true).value, 123);
  assert.equal(d.cellOf("0123", true).value, "0123");
  assert.equal(d.cellOf("2026-02-30").value, "2026-02-30", "不存在的日期照文字写");
  assert.deepEqual(d.parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]], "TSV");
  await assert.rejects(d.render({ format: "xlsx" }, ctx()), /sheets/);
});

test("PowerPoint：结构化幻灯片（标题、要点、表格、图片、备注）与 Markdown 分页，读回来页数与内容一致", async () => {
  const f = write("r.pptx", await d.render({ format: "pptx", title: "汇报", slides: [
    { title: "第三季度汇报", subtitle: "2026 年 10 月" },
    { title: "要点", bullets: ["收入增长 20%", { text: "主要来自新客户", level: 1 }], notes: "这里讲慢一点" },
    { title: "数据", table: { header: ["月份", "收入"], rows: [["七月", 100], ["八月", 120]] }, image: "图.png" },
  ] }, ctx()));
  const text = await read(f);
  assert.equal((text.match(/--- 第 \d+ 页 ---/g) ?? []).length, 3);
  for (const s of ["第三季度汇报", "2026 年 10 月", "收入增长 20%", "主要来自新客户", "（备注）这里讲慢一点", "月份", "八月", "120"]) assert.ok(text.includes(s), `缺少：${s}`);
  assert.ok(entries(f).some((n) => /^ppt\/media\/.+\.png$/.test(n)), "图片放进了幻灯片");

  const g = write("m.pptx", await d.render({ format: "pptx", markdown: "# 封面\n## 副标题\n\n---\n\n# 第二页\n\n- 甲\n- 乙\n  - 乙的细节\n\n备注：讲稿\n\n---\n\n# 第三页\n\n一段文字\n\n| a | b |\n|---|---|\n| 1 | 2 |\n" }, ctx()));
  const t2 = await read(g);
  assert.equal((t2.match(/--- 第 \d+ 页 ---/g) ?? []).length, 3);
  assert.match(t2, /第 1 页 ---\n封面\n副标题/);
  assert.match(t2, /第二页\n甲\n乙\n乙的细节\n（备注）讲稿/);
  assert.match(t2, /一段文字/);
  assert.deepEqual(d.slidesFromMarkdown("# 甲\n\n- 一\n  - 二")[0].bullets, [{ text: "一", level: 0 }, { text: "二", level: 1 }]);
});

test("PDF：中文正文、表格、跨页，pdftotext 与内置的简易解析都读得回来", async (t) => {
  const fonts = pdf.pdfFonts(true);
  if (!fonts) { t.skip("这台机器上没有中文字体"); return; }
  const c = ctx();
  const long = Array.from({ length: 90 }, (_, i) => `第 ${i + 1} 段：这是用来撑满页面的中文内容。`).join("\n\n");
  const f = write("r.pdf", await d.render({ format: "pdf", title: "季度报告", markdown: `${MD}\n\n${long}` }, c));
  assert.equal(fs.readFileSync(f).subarray(0, 5).toString(), "%PDF-");
  assert.ok(c.warnings.some((w) => w.startsWith("PDF 字体：")), "说明用了哪款字体");
  const raw = fs.readFileSync(f).toString("latin1");
  assert.ok((raw.match(/\/Type\s*\/Page\b/g) ?? []).length >= 2, "内容多时分页");
  const fallback = docs.pdfFallback(fs.readFileSync(f));
  for (const s of ["季度报告", "这是中文段落，含 行内代码 与 链接。", "第一点", "子项乙", "项目 金额", "收入 1200", "print('你好')", "引用的一句话", "第 90 段：这是用来撑满页面的中文内容。"]) assert.ok(fallback.includes(s), `简易解析缺少：${s}\n${fallback.slice(0, 600)}`);
  const text = await read(f); // 有 pdftotext 时用它，没有时就是上面的简易解析
  assert.ok(text.includes("季度报告") && text.includes("第 90 段"), text.slice(0, 300));
  assert.ok(fontsOk(fonts));
});
const fontsOk = (f: NonNullable<ReturnType<typeof pdf.pdfFonts>>) => fs.existsSync(f.body.file) && (!f.body.family || pdf.fontNames(f.body.file).includes(f.body.family));

test("PDF 字体：读字体文件的 PostScript 名，字体集里挑简体中文；ToUnicode 的两种写法", () => {
  assert.deepEqual(pdf.fontNames(path.join(work, "图.png")), [], "不是字体文件");
  const f = pdf.pdfFonts(false);
  if (f) assert.ok(pdf.fontNames(f.body.file).length >= 1);
  const ttc = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
  if (fs.existsSync(ttc)) assert.ok(pdf.fontNames(ttc).includes("NotoSansCJKsc-Regular"));
  const cm = docs.parseCMap("1 begincodespacerange\n<0000><ffff>\nendcodespacerange\n2 beginbfchar\n<0001> <4E2D>\n<0002> <6587>\nendbfchar\n1 beginbfrange\n<0003> <0005> <0041>\nendbfrange\n1 beginbfrange\n<0010> <0011> [<4F60> <597D>]\nendbfrange");
  assert.equal(cm.bytes, 2);
  assert.deepEqual([1, 2, 3, 5, 16, 17].map((k) => cm.map.get(k)), ["中", "文", "A", "C", "你", "好"]);
});

test("Markdown / HTML / CSV / JSON 文本报告", async () => {
  assert.equal((await d.render({ format: "md", markdown: "# 标题" }, ctx())).toString(), "# 标题\n");
  const html = (await d.render({ format: "html", title: "报告", markdown: "# 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |" }, ctx())).toString();
  assert.match(html, /<meta charset="utf-8">[\s\S]*<title>报告<\/title>[\s\S]*<table>/);
  assert.match(docs.htmlToText(html), /标题/);
  assert.equal((await d.render({ format: "html", html: "<!doctype html><p>原样</p>" }, ctx())).toString(), "<!doctype html><p>原样</p>");
  const csv = (await d.render({ format: "csv", sheets: [{ columns: ["名字", "说明"], rows: [["甲", "有,逗号"], ["乙", "有\"引号\""]] }] }, ctx())).toString();
  assert.equal(csv, "\uFEFF名字,说明\r\n甲,\"有,逗号\"\r\n乙,\"有\"\"引号\"\"\"\r\n");
  assert.deepEqual(d.parseCsv(csv), [["名字", "说明"], ["甲", "有,逗号"], ["乙", "有\"引号\""]], "写出的 CSV 读回来一致");
  assert.deepEqual(JSON.parse((await d.render({ format: "json", data: { 名字: "甲", n: [1, 2] } }, ctx())).toString()), { 名字: "甲", n: [1, 2] });
  await assert.rejects(d.render({ format: "json", markdown: "{坏" }, ctx()), /不是合法的 JSON/);
});

test("图片：网址不下载、受保护的路径与不是图片的文件不放，都写进注意事项", async () => {
  const c = ctx();
  fs.writeFileSync(path.join(work, "假.png"), "不是图片");
  await d.render({ format: "docx", markdown: `![a](https://example.com/x.png)\n\n![b](假.png)\n\n![c](${path.join(process.env.QUETZAL_HOME!, "secrets", "x.png")})\n\n![d](没有.png)` }, c);
  assert.equal(c.warnings.length, 4, c.warnings.join("\n"));
  assert.match(c.warnings[0], /网址，没有下载/);
  assert.match(c.warnings[1], /不是支持的格式/);
  assert.match(c.warnings[3], /读不到/);
  assert.deepEqual(d.imageSize(png(7, 3), "image/png"), { width: 7, height: 3 });
});

test("文件名：只写进根目录里，扩展名与格式对得上，不覆盖、覆盖只认普通文件、符号链接不跟出去", () => {
  assert.deepEqual(dt.targetName("报告", "docx"), { rel: "报告.docx", format: "docx" });
  assert.deepEqual(dt.targetName("reports/月报.PDF", undefined), { rel: "reports/月报.PDF", format: "pdf" });
  assert.deepEqual(dt.targetName("说明.markdown", undefined), { rel: "说明.markdown", format: "md" });
  assert.deepEqual(dt.targetName("v1.2", "xlsx"), { rel: "v1.2.xlsx", format: "xlsx" });
  assert.match(dt.targetName("a.docx", "pdf") as string, /对不上/);
  for (const bad of ["/etc/passwd", "~/x.docx", "C:\\x.docx", "../x.docx", "a/../../x.docx"]) assert.equal(typeof dt.targetName(bad, "docx"), "string", bad);
  assert.match(dt.targetName("x", undefined) as string, /format/);
  assert.match((dt.targetName(undefined, "pptx", "汇报") as { rel: string }).rel, /^汇报-\d{4}\.pptx$/);
  assert.equal(dt.cleanSegment('..a<b>:c"?.'), "a_b_c_");
  assert.equal(dt.cleanSegment("con.docx"), "_con.docx");

  const root = fs.mkdtempSync(path.join(tmp, "root-"));
  const f1 = dt.place(root, "sub/a.txt", false); fs.writeFileSync(f1, "1");
  assert.equal(f1, path.join(fs.realpathSync(root), "sub", "a.txt"));
  assert.equal(dt.place(root, "sub/a.txt", false), path.join(fs.realpathSync(root), "sub", "a-2.txt"), "同名不覆盖");
  assert.equal(dt.place(root, "sub/a.txt", true), f1, "overwrite 覆盖");
  const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
  fs.symlinkSync(outside, path.join(root, "link"));
  assert.throws(() => dt.place(root, "link/x.txt", false), /符号链接/);
  fs.symlinkSync(path.join(outside, "t.txt"), path.join(root, "s.txt"));
  assert.throws(() => dt.place(root, "s.txt", true), /不是普通文件/);
  assert.equal(path.basename(dt.place(root, "s.txt", false)), "s-2.txt", "同名的是符号链接：另起名字，不写穿过去");
});

// ---------- 工具层、闸门与交付
const chatTurn = (conv: string) => { store.ensureSession(conv, "测试", "控制台"); return new Session("chat", "控制台", undefined, conv); };

test("工具：没有工作区写进交付目录、作为附件放进这一轮；有工作区写进工作区；read_document 读得回来；写审计", async () => {
  assert.ok(allTools().some((x) => x.name === "deliverable_create" && x.permission === "deliverable"));
  assert.equal(guard.PERMISSION_LABELS.deliverable, "生成文件（交付物）");
  const s = chatTurn("d1");
  const r = await callTool("deliverable_create", { name: "周报.docx", markdown: "# 周报\n\n本周完成了**三件事**。" }, "测试", { session: s });
  assert.equal(r.status, "ok", r.text);
  const file = r.text.match(/（文件：(.+)）/)![1];
  assert.ok(file.startsWith(path.join(process.env.QUETZAL_DELIVERABLES_DIR!, "")), file);
  assert.match(path.dirname(file), /\d{4}-\d{2}-\d{2}$/, "按日期分子目录");
  assert.match(r.text, /会作为附件随你这一轮的回复交给对方/);
  assert.equal(s.outbox.length, 1);
  const a = s.outbox[0];
  assert.deepEqual([a.name, a.by, a.source, a.kind], ["周报.docx", "agent", file, "file"]);
  assert.ok(att.resolveUpload(a.rel), "另存了一份在 uploads（下载、复制与对方上传的附件同一套规则）");
  assert.match(await (await callTool("read_document", { path: file }, "核对", { session: s })).text, /本周完成了三件事/);
  assert.ok(store.listAudit(50).some((x) => x.action === "deliverable_create" && x.result.startsWith("已生成")), "写审计");

  // 同名再生成一次：不覆盖
  const r2 = await callTool("deliverable_create", { name: "周报.docx", markdown: "第二版" }, "测试", { session: s });
  assert.match(r2.text, /另起名为 周报-2\.docx/);

  // 有工作区：写进工作区（相对路径的图片也从工作区算）
  const dir = fs.mkdtempSync(path.join(tmp, "ws-"));
  fs.writeFileSync(path.join(dir, "logo.png"), png(10, 10));
  ws.setWorkspace("d2", { body: config.body, dir, source: "user" });
  const s2 = chatTurn("d2");
  const r3 = await callTool("deliverable_create", { name: "out/汇报.pptx", slides: [{ title: "封面" }, { title: "图", image: "logo.png" }], send: false }, "测试", { session: s2 });
  assert.equal(r3.status, "ok", r3.text);
  assert.ok(fs.existsSync(path.join(fs.realpathSync(dir), "out", "汇报.pptx")));
  assert.doesNotMatch(r3.text, /注意/, "图片从工作区找到了");
  assert.equal(s2.outbox.length, 0, "send=false 不交付");
  s.close(); s2.close();
});

test("工具：拒绝写到工作区外面；格式不对、内容不合格如实失败；canvas 作为来源", async () => {
  const s = chatTurn("d3");
  for (const name of ["/tmp/x.docx", "../x.docx"]) {
    const r = await callTool("deliverable_create", { name, markdown: "x" }, "测试", { session: s });
    assert.equal(r.status, "error"); assert.match(r.text, /只写进工作区/);
  }
  assert.equal((await callTool("deliverable_create", { name: "x.pptx" }, "测试", { session: s })).status, "error");
  const doc = cv.createCanvas({ conv: "d3", title: "方案", content: "# 方案\n\n- 甲\n- 乙\n", author: "agent" });
  const r = await callTool("deliverable_create", { format: "docx", canvas: doc.id }, "测试", { session: s });
  assert.equal(r.status, "ok", r.text);
  assert.match(r.text, /方案-\d{4}\.docx/, "没给名字按 canvas 的标题起名");
  assert.match(await read(r.text.match(/（文件：(.+)）/)![1]), /方案\n甲\n乙/);
  const t = cv.createCanvas({ conv: "d3", title: "表", kind: "code", lang: "csv", content: "a,b\n1,2\n", author: "agent" });
  const x = await callTool("deliverable_create", { format: "xlsx", canvas: t.id, name: "表" }, "测试", { session: s });
  assert.match(await read(x.text.match(/（文件：(.+)）/)![1]), /a\tb\n1\t2/);
  assert.match((await callTool("deliverable_create", { format: "docx", canvas: "cv-000000000000" }, "测试", { session: s })).text, /没有/);
  s.close();
});

test("闸门：类别禁止时不生成；覆盖已有文件归「删除找不回的数据」送审（审核没有结论时按高风险拦下）", async () => {
  const s = chatTurn("d4");
  guard.setLevel("deliverable", "deny", "测试");
  const r = await callTool("deliverable_create", { name: "禁.md", markdown: "x" }, "测试", { session: s });
  assert.equal(r.status, "denied");
  assert.ok(!fs.existsSync(path.join(process.env.QUETZAL_DELIVERABLES_DIR!, "禁.md")));
  guard.setLevel("deliverable", "allow", "测试");
  assert.equal(sentinel.classify({ tool: "deliverable_create", permission: "deliverable", args: { overwrite: true } }), "destructive");
  assert.equal(sentinel.classify({ tool: "deliverable_create", permission: "deliverable", args: {} }), undefined, "不覆盖的生成不送审");
  const before = store.listAudit(500, { action: "sentinel.review" }).length;
  const o = await callTool("deliverable_create", { name: "周报.docx", markdown: "覆盖", overwrite: true }, "测试", { session: s });
  assert.equal(o.status, "denied", o.text); // 测试里没有可用的审核模型：高风险类拦下
  assert.match(o.text, /审核没有完成/);
  assert.equal(store.listAudit(500, { action: "sentinel.review" }).length, before + 1, "审核写审计");
  s.close();
});

test("跨身体：deliverable_create 在可被别的身体调用的清单里，别处调来时写进带来的工作区目录、不交付附件", async () => {
  assert.ok(REMOTE_CORE_TOOLS.has("deliverable_create"));
  assert.ok(limbTools(REMOTE_CORE_TOOLS).some((x) => x.name === "deliverable_create"));
  assert.ok(ws.ROUTED.has("deliverable_create"), "工作区在另一具身体上时放到那边生成");
  const dir = fs.mkdtempSync(path.join(tmp, "remote-ws-"));
  const r = await callTool("deliverable_create", { name: "远.md", markdown: "# 远" }, "来自 别的身体", { signal: new AbortController().signal, cwd: dir });
  assert.equal(r.status, "ok", r.text);
  assert.ok(fs.existsSync(path.join(fs.realpathSync(dir), "远.md")));
  assert.match(r.text, /另一具身体调过来的，文件留在这里/);
});

test("醒来时：生成的文件随下一条 send_message 发出（say 事件带着附件）；子 agent 不交付", async () => {
  const s = new Session("think", "", undefined, "");
  const r = await callTool("deliverable_create", { name: "想法.md", markdown: "# 想法" }, "醒来", { session: s });
  assert.match(r.text, /随你接下来的一条 send_message 一起发出/);
  let got: unknown;
  const on = (_t: string, to: unknown) => { got = to; };
  bus.on("say", on);
  const m = await callTool("send_message", { text: "给你写了点东西", new_session: "想法" }, "醒来", { session: s });
  bus.off("say", on);
  assert.match(m.text, /附上了 想法\.md/);
  assert.deepEqual((got as { files: { name: string }[] }).files.map((f) => f.name), ["想法.md"]);
  assert.equal(s.outbox.length, 0);
  s.close();
  const sub = new Session("agent", "", undefined, "d5");
  assert.match((await callTool("deliverable_create", { name: "子.md", markdown: "x" }, "子 agent", { session: sub })).text, /子 agent 不能直接给对方发附件/);
  assert.equal(sub.outbox.length, 0);
  sub.close();
});

test("对话：她调用 deliverable_create 后，回复带着文件附件入库，飞书据此取到要发的文件，历史里写明发过什么", async () => {
  let n = 0;
  server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      n++;
      const choice = n === 1
        ? { finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "deliverable_create", arguments: JSON.stringify({ name: "预算表.xlsx", sheets: [{ name: "预算", columns: ["项目", "金额"], rows: [["房租", 3000], ["合计", "=SUM(B2:B2)"]] }] }) } }] } }
        : { finish_reason: "stop", message: { content: "做好了，附件里是预算表。" } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [choice], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  reg.saveProviders({ providers: [{ id: "p", catalogId: "custom", name: "Mock", baseUrl: base, protocol: "openai-completions" as const, enabled: true,
    keys: [{ id: "k", label: "k", lastFour: "", enabled: true, secret: "sk-mock-000000" }], models: [{ id: "m", name: "plain", enabled: true, context: 131072, maxTokens: 256, sortOrder: 0 }] }] } as never, reg.configVersion());
  const t0 = Date.now();
  const reply = await converse("你", "帮我做一张预算表", "控制台", { conv: "d6" });
  assert.equal(reply, "做好了，附件里是预算表。");
  const last = store.sessionMessages("d6").at(-1)!;
  assert.equal(last.role, "agent");
  assert.deepEqual(last.attachments?.map((a) => [a.name, a.by]), [["预算表.xlsx", "agent"]]);
  assert.match(await read(last.attachments![0].path), /房租\t3000\n合计\t=SUM\(B2:B2\)/);
  assert.deepEqual(att.agentFiles(["d6"], t0).map((a) => a.name), ["预算表.xlsx"], "飞书在回复之后另发这些文件");
  assert.deepEqual(att.agentFiles(["d6"], Date.now() + 1000), [], "只取这一轮之后的");
  // 下一轮的历史里，她看得到自己上一轮随回复发了什么
  const { history } = await import("../src/mind/brain.ts");
  assert.ok(history("d6", -1).some((m) => /随这条消息交给对方的文件：预算表\.xlsx/.test(String(m.content))));
});

test("工作区在另一具在线的身体上：放到那边生成（带上工作区目录），再经 file.read 取回一份作附件；那边不在线时在这里生成并说明", async () => {
  const { setBodies } = await import("../src/mind/bodies.ts");
  const uuid = await import("../src/body/uuid.ts");
  const crypto = await import("node:crypto");
  const PC = uuid.deviceUuid("pc-machine-id-deliv");
  const made = await d.render({ format: "docx", markdown: "# 远端的报告" }, ctx());
  const calls: { tool: string; cwd?: string }[] = [];
  let up = true;
  setBodies({
    list: () => (up ? [{ body: "pc", uuid: PC, claimed: PC, describe: "", tools: [] }] : []),
    registry: () => [{ body: "pc", uuid: PC }],
    call: async (_b, tool, _a, _r, _s, o) => { calls.push({ tool, cwd: o?.cwd }); return { text: "已生成 Word 文档 报告.docx（10 KB），写在工作区 /home/u/proj里。\n（文件：/home/u/proj/报告.docx）", status: "ok" }; },
    move: async () => "",
    file: async () => ({ path: "/home/u/proj/报告.docx", size: made.length, sha256: crypto.createHash("sha256").update(made).digest("hex"), data: made.toString("base64") }),
  });
  ws.setWorkspaceMesh({ online: (b: string) => up && b === "pc", overview: () => undefined, probe: async (_b: string, dir: string) => ({ dir, exists: true }), runAgent: async () => ({ id: "x", name: "x" }) } as never);
  const s = chatTurn("d7");
  try {
    ws.setWorkspace("d7", { body: "pc", dir: "/home/u/proj", source: "user" });
    const r = await callTool("deliverable_create", { name: "报告.docx", markdown: "# 远端的报告" }, "测试", { session: s });
    assert.equal(r.status, "ok", r.text);
    assert.deepEqual(calls.at(-1), { tool: "deliverable_create", cwd: "/home/u/proj" });
    assert.match(r.text, /在工作区所在的 pc 上[\s\S]*已从 pc 取回一份/);
    assert.equal(s.outbox.length, 1);
    assert.match(await read(s.outbox[0].path), /远端的报告/, "取回的就是那边生成的文件");
    up = false;
    const local = await callTool("deliverable_create", { name: "离线.md", markdown: "x" }, "测试", { session: s });
    assert.match(local.text, /工作区在 pc 上，它此刻不在线[\s\S]*已生成 Markdown 离线\.md/);
  } finally { s.close(); setBodies(undefined); ws.setWorkspaceMesh(undefined); }
});
