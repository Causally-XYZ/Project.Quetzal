---
title: "Generating files: reports, spreadsheets and slides"
description: The agent turns what it wrote into real Word, Excel, PowerPoint and PDF files (or Markdown, HTML, CSV, JSON), saves them in the task's workspace and attaches them to its reply.
---

## What it can do

When you ask for a weekly report, a budget sheet or a deck for a meeting, you no longer have to copy things out of chat bubbles: the agent generates the file and sends it along with its reply.

| You want | It generates | What goes in |
|---|---|---|
| A report, a proposal, an article | Word (.docx) or PDF | Headings, paragraphs, bold and italics, lists, tables, code blocks, quotes, images |
| A table, a ledger, a list | Excel (.xlsx) or CSV | Several sheets, a header row, numbers, dates, formulas (such as `=SUM(…)` for a total row), column widths and number formats |
| Slides for a presentation | PowerPoint (.pptx) | A title per slide, bullet points (with levels), tables, images, speaker notes |
| A web page, data | HTML, Markdown, JSON | Written as is |

Just say "make it an Excel sheet" or "export it as a PDF"; if you don't say, the agent picks a format that suits the content. A document you edited together in Canvas can be turned into a file as well.

## Receiving the file

- **Console**: the file appears above the agent's reply as a card with its name, type and size.
  - Click the card or *Preview* to look inside: Excel shows the first rows of each sheet; Word, PDF and slides show the beginning of the text.
  - *Download*: a save dialog on a computer, the system's location picker on a phone, a plain download in the web console.
  - The desktop app (Linux, Windows, macOS) also has *Open*, which opens the file in an application on your computer (Office, LibreOffice, WPS, the system PDF viewer…).
- **Feishu**: after the reply, the file arrives as a separate message.
- Something the agent made on its own while awake arrives with the message it sends you.

## Where the files go

- When the task has a **workspace** (the agent cloned a repository into a folder and works there, or you set a workspace for the conversation in the console), the file is written into the workspace, next to the rest of the task's files. If the workspace is on another device, the file is generated there and a copy is fetched back to send to you.
- Without a workspace it goes to `deliverables/<date>/` under the agent's working directory (on Linux and macOS usually `~/Quetzal/deliverables/`).
- Files are written only in those two places, never elsewhere. If a file with the same name exists it is not overwritten; the new one gets another name (`report-2.docx`). When you explicitly ask the agent to overwrite, that step goes to the safety review first.
- What you receive is a copy: if the agent later edits the file in the workspace, the copy you already have does not change.

## Chinese text in PDFs

A PDF has to carry its fonts for Chinese (and Japanese, Korean) text to show correctly everywhere. Quetzal does not ship a font; it uses a Chinese font already on the device. Android phones, Windows, macOS and most Linux installations with Chinese support have one.

If none is found, the agent does not hand you a PDF full of boxes. It tells you what to do instead:

- On Linux, install one, for example `sudo apt install fonts-noto-cjk` on Debian / Ubuntu or `sudo dnf install google-noto-sans-cjk-fonts` on Fedora;
- or put a `.ttf` / `.otf` / `.ttc` font file into the `fonts/` folder of the Quetzal home directory (see [Home directory](/docs/reference/home-directory));
- or generate a Word file first; whichever device opens it uses its own fonts.

## The agent checks its work

After generating a file, the agent can read it back with its document reader to check the content and make sure the numbers ended up in the table.

## Permissions

Generating files is its own permission category, *Generate files (deliverables)*, allowed by default because it only writes into the workspace or the deliverables folder. Under **Control → Permissions** you can change it to review, ask every time, or deny. Overwriting an existing file is also checked by the safety review as "deleting data that cannot be recovered".

## Implementation details

The open-source libraries used (docx, exceljs, pptxgenjs, pdfkit and marked, all MIT licensed), the order in which fonts are looked up and the file placement rules are described in [ARCHITECTURE.md §5.8](https://github.com/PlutoKeating/Project.Quetzal/blob/main/docs/ARCHITECTURE.md) in the source repository; the interfaces the console uses are in the [Gateway API](/docs/reference/gateway-api).
