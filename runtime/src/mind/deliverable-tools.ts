// 交付物的工具 deliverable_create（issue #18）：她把报告、表格、演示文稿生成文件，写进工作区，并作为她回复的附件交给对方。
//   放在哪里：这一轮的工作区在这具身体上 → 工作区目录；别处调来、带着工作区目录（cwd）→ 那个目录；没有工作区 → 交付目录
//     （命令工作目录下的 deliverables/<当地日期>/；工作目录就是用户主目录时为 ~/Quetzal/deliverables/<日期>/，与 Canvas 的运行目录同一个道理；
//     环境变量 QUETZAL_DELIVERABLES_DIR 可以另指）。工作区在另一具在线的身体上时，经 body_call 同样的通道放到那具身体上生成（写进那边的工作区），
//     再经跨身体取文件（file.read）取回一份作附件。
//   只写进这个根目录里：文件名里的绝对路径、..、指向外面的符号链接、受保护的目录一律拒绝；不覆盖已有文件（同名另起 名字-2），
//     要覆盖须明说 overwrite（归「删除找不回的数据」风险类别，按 #29 的规则送审）。
//   闸门：能力类别「生成文件」（deliverable，缺省允许）；档位、送审与审计都走 callTool。
//   交付：生成的文件另存一份到 uploads（与对方上传的附件同一套存放、下载与复制规则，附件标 by: agent），放进这一轮的 outbox：
//     对话随这一轮的回复入库（控制台显示为文件卡片，飞书另发文件）；醒来时随下一条 send_message 发出；子 agent 与别处调来的不交付，只给路径。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { failed, type Tool, type ToolContext, type ToolFailure } from "./tools.ts";
import { config } from "../config.ts";
import { workDir, protectedPath } from "../sandbox.ts";
import { parts } from "../time/zone.ts";
import { saveUpload, MAX_FILES, MAX_FILE_BYTES } from "./attachments.ts";
import * as ws from "./workspace.ts";
import * as cv from "./canvas.ts";
import { remoteBodies } from "./bodies.ts";
import { fetchFile } from "./body-files.ts";
import { render, FORMATS, FORMAT_LABEL, DeliverableError, type Format, type Spec } from "./deliverables.ts";
import type { Attachment } from "../store.ts";

/** 没有工作区时的交付目录（按日期分子目录）。 */
export const deliverablesRoot = () => process.env.QUETZAL_DELIVERABLES_DIR || (workDir() === os.homedir() ? path.join(os.homedir(), "Quetzal", "deliverables") : path.join(workDir(), "deliverables"));
const today = () => { const p = parts(Date.now(), config.timezone); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; };
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/** 文件名的一段：去掉路径与控制字符、Windows 不收的字符，不以点或减号开头，避开 Windows 保留名，最长 120 个字符。 */
export function cleanSegment(s: string): string {
  let n = s.normalize("NFC").replace(/[\\/:*?"<>|\x00-\x1f\x7f]+/g, "_").replace(/^[\s.-]+/, "").replace(/[\s.]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`;
  if (n.length > 120) { const ext = path.extname(n).slice(0, 12); n = n.slice(0, 120 - ext.length) + ext; }
  return n;
}

/**
 * 算出要写的文件：root 之内的相对路径（可以带子目录，最多 4 层）。绝对路径、~、盘符、.. 一律拒绝（写进工作区以外不允许）。
 * 扩展名缺了补上，和格式对不上（.docx 却要 pdf）时报错。返回相对路径与格式。
 */
export function targetName(name: unknown, format: unknown, title?: string): { rel: string; format: Format } | string {
  const raw = typeof name === "string" ? name.trim() : "";
  if (/^([\\/]|~|[A-Za-z]:)/.test(raw) || raw.includes("\0")) return "name 只能是文件名或工作区里的相对路径（不能是绝对路径）：文件只写进工作区（没有工作区时写进交付目录）";
  const segs = raw.split(/[\\/]+/).filter(Boolean);
  if (segs.some((x) => x === ".." || x === ".")) return "name 里不能有 .. 或 .：文件只写进工作区（没有工作区时写进交付目录）";
  if (segs.length > 4) return "name 的子目录最多 4 层";
  const ext = segs.length ? path.extname(segs[segs.length - 1]).slice(1).toLowerCase() : "";
  const known = (FORMATS as readonly string[]).includes(ext === "markdown" ? "md" : ext === "htm" ? "html" : ext) ? (ext === "markdown" ? "md" : ext === "htm" ? "html" : ext) as Format : undefined;
  const fmt = typeof format === "string" && format ? format.toLowerCase().replace(/^\./, "").replace(/^markdown$/, "md").replace(/^htm$/, "html") : known;
  if (!fmt || !(FORMATS as readonly string[]).includes(fmt)) return `format 要是 ${FORMATS.join(" / ")} 之一（或在 name 里带上扩展名）`;
  if (known && known !== fmt) return `name 的扩展名 .${ext} 与 format ${fmt} 对不上`;
  const stamp = (() => { const p = parts(Date.now(), config.timezone); return `${String(p.h).padStart(2, "0")}${String(p.mi).padStart(2, "0")}`; })();
  if (!segs.length) segs.push(`${cleanSegment(title ?? "") || "交付物"}-${stamp}`);
  const clean = segs.map(cleanSegment);
  if (clean.some((x) => !x)) return "name 不对";
  const last = clean.length - 1;
  if (!known) clean[last] = `${clean[last]}.${fmt}`;
  return { rel: clean.join("/"), format: fmt as Format };
}

/** 这一轮把文件写在哪个根目录：工作区（本机的、或别处调来时带的）或交付目录。 */
function rootOf(ctx: ToolContext): { root: string; where: string } {
  const cwd = ctx.cwd ? ws.usableDir(ctx.cwd) : undefined;
  if (cwd) return { root: cwd, where: `工作区 ${cwd}` };
  const w = ws.workspaceOf(ctx.session);
  const dir = w && w.body === config.body ? ws.usableDir(w.dir) : undefined;
  if (dir) return { root: dir, where: `工作区 ${dir}` };
  return { root: path.join(deliverablesRoot(), today()), where: `交付目录 ${path.join(deliverablesRoot(), today())}${w ? `（这个会话的工作区 ${w.body}:${w.dir} 此刻用不了）` : ""}` };
}

/** 写进 root 里的 rel：建好目录，核对真实路径仍在 root 里、不是受保护的目录；已有同名文件时不覆盖（另起名字），overwrite 才覆盖普通文件。 */
export function place(root: string, rel: string, overwrite: boolean): string {
  fs.mkdirSync(root, { recursive: true });
  const rroot = real(root);
  const deny = protectedPath(rroot);
  if (deny) throw new DeliverableError(deny);
  const want = path.resolve(rroot, rel);
  if (!within(want, rroot)) throw new DeliverableError("文件只写进工作区（没有工作区时写进交付目录）");
  fs.mkdirSync(path.dirname(want), { recursive: true });
  const dir = real(path.dirname(want));
  if (!within(dir, rroot)) throw new DeliverableError("这个子目录经符号链接指到了工作区外面，没有写");
  const blocked = protectedPath(path.join(dir, path.basename(want)));
  if (blocked) throw new DeliverableError(blocked);
  const ext = path.extname(want), stem = path.basename(want, ext);
  for (let i = 1; i <= 999; i++) {
    const f = path.join(dir, i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`);
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(f); } catch { return f; }
    if (st.isSymbolicLink() || !st.isFile()) { if (overwrite && i === 1) throw new DeliverableError(`${f} 不是普通文件（符号链接、目录），没有覆盖`); continue; }
    if (overwrite && i === 1) return f;
  }
  throw new DeliverableError("同名的文件太多");
}

/** 原子地写：先写临时文件再改名（写到一半出错不留下半个文件）。 */
function writeAtomic(file: string, data: Buffer) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, data, { flag: "wx" });
  try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/** 交给对方：另存一份到 uploads（附件的存放、下载与复制规则与对方上传的相同），放进这一轮的 outbox。返回附件与给她的说明。 */
export function deliver(ctx: ToolContext, file: string, data: Buffer): { att?: Attachment; note: string } {
  const s = ctx.session;
  if (!s) return { note: "（这次是另一具身体调过来的，文件留在这里，没有作为附件发出）" };
  if (s.origin === "agent") return { note: "（子 agent 不能直接给对方发附件：把这个路径写进你的报告，派你出来的她会决定怎么交给对方）" };
  if (s.origin === "dream") return { note: "（做梦时不给对方发文件；文件留在这里）" };
  if (s.outbox.length >= MAX_FILES) return { note: `（这一轮要发的附件已经有 ${MAX_FILES} 个，这个没有再加；文件留在这里）` };
  if (data.length > MAX_FILE_BYTES) return { note: `（文件超过 ${MAX_FILE_BYTES >> 20} MB，没有作为附件发出；文件留在这里）` };
  const att: Attachment = { ...saveUpload(path.basename(file), data), by: "agent", source: file };
  s.outbox.push(att);
  return { att, note: s.origin === "chat" ? "会作为附件随你这一轮的回复交给对方（控制台里是可以下载的文件卡片；对方在飞书里时也会发过去）。" : "会作为附件随你接下来的一条 send_message 一起发出。" };
}

/** 来源：某份 canvas 的当前内容（Markdown 文档或代码）。 */
function fromCanvas(id: string, spec: Spec): Spec {
  const v = cv.getCanvas(id);
  const out = { ...spec, title: spec.title ?? v.title };
  if (spec.format === "xlsx" || spec.format === "csv") return spec.sheets?.length || typeof spec.csv === "string" ? out : { ...out, csv: v.content };
  if (spec.format === "json") return spec.data !== undefined ? out : { ...out, markdown: v.content };
  if (spec.format === "html" && v.kind === "code" && v.lang === "html") return { ...out, html: v.content };
  const md = v.kind === "code" ? `# ${v.title}\n\n\`\`\`${v.lang}\n${v.content}\n\`\`\`\n` : v.content;
  return spec.markdown ? out : { ...out, markdown: md };
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const str = (description: string) => ({ type: "string", description });
const cellSchema = { anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }, { type: "object" }], description: "单元格：数字、文字、布尔或 null；「=」开头的文字是公式（如 =SUM(B2:B9)）；ISO 日期（2026-10-18 或 2026-10-18T14:30）写成日期；也可以是 {formula, result?}、{date}、{value, format?, bold?}" };

export async function createDeliverable(a: Record<string, any>, ctx: ToolContext): Promise<string | ToolFailure> {
  const canvasTitle = typeof a.canvas === "string" && a.canvas.trim() && !(typeof a.title === "string" && a.title.trim()) ? cv.getDoc(a.canvas.trim())?.title : undefined; // 没给名字时按 canvas 的标题起名
  const t = targetName(a.name, a.format, typeof a.title === "string" && a.title.trim() ? a.title : canvasTitle);
  if (typeof t === "string") return failed(t);
  // 工作区在另一具在线的身体上：放到那边生成（写进那边的工作区），再取回一份作附件
  const routed = await ws.routeTool("deliverable_create", a, ctx);
  if (routed && "text" in routed) {
    if (routed.status !== "ok") return failed(routed.text);
    const w = ws.workspaceOf(ctx.session), remote = w ? remoteBodies().find((b) => b.body === w.body) : undefined;
    const file = [...routed.text.matchAll(/（文件：([^\n）]+)）/g)].pop()?.[1];
    if (!file || !remote || a.send === false) return routed.text;
    try {
      const got = await fetchFile(remote, file, "交付物：取回一份作附件");
      const d = deliver(ctx, got.local, fs.readFileSync(got.local));
      return `${routed.text}\n已从 ${remote.body} 取回一份（${got.local}）：${d.note}`;
    } catch (e) { return `${routed.text}\n（没能从 ${remote.body} 取回作附件：${(e as Error).message}；文件在 ${remote.body} 上）`; }
  }
  const pre = routed && "note" in routed ? routed.note : ""; // 工作区所在的身体不在线：在这里生成
  let spec: Spec = {
    format: t.format, title: typeof a.title === "string" && a.title.trim() ? a.title.trim().slice(0, 200) : undefined, author: typeof a.author === "string" ? a.author.slice(0, 100) : undefined,
    markdown: typeof a.markdown === "string" ? a.markdown : undefined, html: typeof a.html === "string" ? a.html : undefined, csv: typeof a.csv === "string" ? a.csv : undefined,
    data: a.data, sheets: Array.isArray(a.sheets) ? a.sheets : undefined, slides: Array.isArray(a.slides) ? a.slides : undefined,
  };
  if (typeof a.canvas === "string" && a.canvas.trim()) { try { spec = fromCanvas(a.canvas.trim(), spec); } catch (e) { return failed(e instanceof cv.CanvasError ? e.message : String((e as Error).message)); } }
  const { root, where } = rootOf(ctx);
  const rc = { baseDir: root, warnings: [] as string[], images: 0 };
  let data: Buffer;
  try {
    ctx.session?.check();
    data = await render(spec, rc);
  } catch (e) { if (e instanceof DeliverableError) return failed(e.message); throw e; }
  if (data.length > 200 << 20) return failed(`生成的文件太大（${kb(data.length)}）`);
  let file: string;
  try { file = place(root, t.rel, a.overwrite === true); writeAtomic(file, data); }
  catch (e) { return failed(e instanceof DeliverableError ? e.message : `没有写成：${(e as Error).message}`); }
  const renamed = path.basename(file) !== path.basename(t.rel) ? `（已有同名文件，另起名为 ${path.basename(file)}；要覆盖就带 overwrite: true）` : "";
  const sent = a.send === false ? { note: "（send=false：没有作为附件发出）" } : deliver(ctx, file, data);
  const warn = rc.warnings.length ? `\n注意：\n${rc.warnings.map((w) => `- ${w}`).join("\n")}` : "";
  return `${pre}已生成 ${FORMAT_LABEL[t.format]} ${path.basename(file)}（${kb(data.length)}），写在${where}里${renamed}。\n（文件：${file}）\n${sent.note}\n可以用 read_document 读回来核对内容。${warn}`;
}

export function deliverableTools(): Tool[] {
  return [{
    name: "deliverable_create", permission: "deliverable",
    description: "生成交付文件：Word（docx）、Excel（xlsx）、PowerPoint（pptx）、PDF，或直接写出 Markdown / HTML / CSV / JSON 文本报告。文件写进这个会话的工作区（没有工作区时写进交付目录 deliverables/<日期>/），并作为附件随你的回复交给对方（控制台里是可以下载的文件卡片，飞书里另发文件）。" +
      "内容按格式给：docx / pdf / html / md 给 markdown（标题、段落、粗斜体、列表、表格、代码块、引用、本地图片 ![说明](相对工作区的路径)）；xlsx 给 sheets（每个工作表 name、columns 表头与列宽 / 数字格式、rows 二维数组；单元格可以是数字、文字、公式「=SUM(B2:B9)」、ISO 日期）或 csv；pptx 给 slides（每页 title、subtitle、bullets 要点、text、image、table {header, rows}、notes 演讲者备注）或 markdown（单独一行的 --- 分页，每页第一个标题是这页的标题，「备注：」开头的段落进备注）；csv 给 csv 或 sheets；json 给 data。" +
      "也可以给 canvas（一份 canvas 的 id）直接取它的内容。不覆盖已有文件（同名另起名字），要覆盖带 overwrite: true。生成后可以用 read_document 读回核对。PDF 的中文要用这具身体上的中文字体，找不到时会说明怎么办。",
    parameters: obj({
      format: { type: "string", enum: [...FORMATS], description: "格式（name 带了扩展名时可以不给）" },
      name: str("文件名，如「季度报告.docx」；可以带工作区里的子目录（reports/季度报告.docx），不能是绝对路径。不给就按标题起名"),
      title: str("标题（写进文件属性；docx / pdf 正文没有一级标题时放在最前面）"),
      markdown: str("Markdown 正文（docx / pdf / html / md；pptx 按 --- 分页）"),
      canvas: str("可选：取这份 canvas（id）的当前内容作为来源"),
      sheets: { type: "array", description: "xlsx / csv：工作表", items: obj({
        name: str("工作表名"), freeze: { type: "boolean", description: "冻结表头（缺省是）" }, csv: str("这个工作表的 CSV（第一行是表头）"),
        columns: { type: "array", items: { anyOf: [{ type: "string" }, obj({ header: str("表头"), width: { type: "number", description: "列宽（字符数）" }, format: str("数字格式，如 #,##0.00、0.0%、yyyy-mm-dd") })] } },
        rows: { type: "array", items: { type: "array", items: cellSchema } },
      }) },
      csv: str("CSV 文本（xlsx 的单个工作表，或直接写出 csv）"),
      slides: { type: "array", description: "pptx：幻灯片", items: obj({
        title: str("标题"), subtitle: str("副标题"), text: str("一段文字"), image: str("本地图片路径（相对工作区）"), notes: str("演讲者备注"),
        bullets: { type: "array", items: { anyOf: [{ type: "string" }, obj({ text: { type: "string" }, level: { type: "integer", minimum: 0, maximum: 4 } })] } },
        table: obj({ header: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } } } }),
      }) },
      html: str("html：直接给 HTML（完整页面或片段）"),
      data: { anyOf: [{ type: "object" }, { type: "array", items: { anyOf: [{ type: "object" }, { type: "string" }, { type: "number" }, { type: "boolean" }] } }], description: "json：要写出的数据（对象或数组）" },
      overwrite: { type: "boolean", description: "覆盖同名的已有文件（缺省不覆盖，另起名字）" },
      send: { type: "boolean", description: "作为附件交给对方（缺省是）" },
    }),
    handler: (a, ctx) => createDeliverable(a, ctx),
  }];
}
