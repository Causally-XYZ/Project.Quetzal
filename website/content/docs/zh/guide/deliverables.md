---
title: 生成文件：报告、表格与演示文稿
description: ta 把写好的内容直接生成 Word、Excel、PowerPoint、PDF 文件（也能写 Markdown、HTML、CSV、JSON），放进这件事的工作区，作为附件随回复交给你。
---

## 它能做什么

请 ta 写周报、整理一张预算表、做一份汇报用的幻灯片时，不用再从聊天气泡里复制粘贴：ta 直接生成文件，随回复一起发给你。

| 你要的 | ta 生成 | 里面有什么 |
|---|---|---|
| 报告、方案、文章 | Word（.docx）或 PDF | 标题、段落、粗体斜体、列表、表格、代码块、引用、图片 |
| 表格、账本、清单 | Excel（.xlsx）或 CSV | 多个工作表、表头、数字、日期、公式（比如合计行的 `=SUM(…)`）、列宽与数字格式 |
| 汇报用的幻灯片 | PowerPoint（.pptx） | 每页的标题、要点（可以分级）、表格、图片、演讲者备注 |
| 网页、数据 | HTML、Markdown、JSON | 原样写出 |

你可以直接说「做成 Excel」「导出成 PDF」；没说格式时，ta 按内容自己选。Canvas 里和 ta 一起改好的文档，也可以让 ta 直接生成文件。

## 收到文件

- **控制台**：文件出现在 ta 那条回复的上面，是一张卡片，写着文件名、类型和大小。
  - 点卡片或「预览」看里面的内容：Excel 显示各个工作表的前几行，Word、PDF、幻灯片显示开头的文字。
  - 「下载」：电脑上弹出保存对话框，手机上交给系统选位置，网页版直接下载。
  - 电脑版（Linux、Windows、macOS）还有「打开」：用电脑上的应用（WPS、Office、LibreOffice、系统的 PDF 阅读器……）直接打开。
- **飞书**：ta 回复之后，文件另发一条消息给你。
- ta 自己醒来时做好的东西，会随 ta 发给你的那条主动消息一起到。

## 文件放在哪里

- 这件事有**工作区**时（ta 在某个目录里克隆了仓库、在那里做事，或者你在控制台里给这个会话设了工作区），文件写进工作区，和这件事的其他文件放在一起。工作区在另一台设备上时，文件在那台设备上生成，再取一份回来发给你。
- 没有工作区时，写进 ta 的工作目录下的 `deliverables/<日期>/`（Linux、macOS 上通常是 `~/Quetzal/deliverables/`）。
- 只会写在这两个地方，不会写到别处；同名的文件已经存在时不覆盖，另起一个名字（`报告-2.docx`）。你明确要 ta 覆盖时，这一步会先交给安全审核判断。
- 发给你的是一份副本：之后 ta 再改工作区里的文件，你已经收到的那份不会变。

## PDF 里的中文

PDF 要把字体放进文件里，中文才能在任何设备上正确显示。Quetzal 不自带字体，而是用这台设备上已有的中文字体：安卓手机、Windows、macOS 和大多数装了中文的 Linux 都有。

找不到中文字体时，ta 不会给你一份满是方块的 PDF，而是告诉你怎么办：

- Linux：装一款中文字体，例如 Debian / Ubuntu 上 `sudo apt install fonts-noto-cjk`，Fedora 上 `sudo dnf install google-noto-sans-cjk-fonts`；
- 或者把一个 `.ttf` / `.otf` / `.ttc` 字体文件放进 Quetzal 家目录的 `fonts/` 文件夹里（见[家目录](/docs/reference/home-directory)）；
- 或者先生成 Word，打开它的设备会用自己的字体显示。

## ta 会核对

生成之后，ta 可以用读文档的能力把文件读回来，核对内容对不对、表格的数字是不是写进去了。

## 权限

生成文件属于「生成文件（交付物）」这一类权限，缺省允许：它只写进工作区或交付目录。在 **控制 → 权限** 里可以改成「交给审核模型」「每次询问」或「禁止」。覆盖已有的文件另按「删除找不回的数据」交给安全审核。

## 实现细节

用到的开源库（docx、exceljs、pptxgenjs、pdfkit、marked，都是 MIT 许可）、字体的探测顺序与文件放置的规则见源码仓库的 [ARCHITECTURE.md §5.8](https://github.com/PlutoKeating/Project.Quetzal/blob/main/docs/ARCHITECTURE.md)；控制台用到的接口见[网关接口](/docs/reference/gateway-api)。
