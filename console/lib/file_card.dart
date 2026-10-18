// 附件的文件卡片（#18）：她生成的交付物（Word / Excel / PowerPoint / PDF / Markdown / HTML / CSV / JSON）与对方发来的文档。
//   显示名称、类型与大小；「下载」取回内容后交给系统保存（桌面弹保存对话框、手机交给系统选位置、网页直接下载）；
//   桌面版另有「打开」（存到临时目录后用系统应用打开）；「预览」经网关 uploads.preview 取开头的文字，Excel 显示成各工作表的前几行。
//   文件只在生成它的那具身体上（附件随消息复制到别的身体时只带名字与路径）：下载不到时如实说明在哪具身体上。
import 'dart:typed_data';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'api.dart';
import 'widgets.dart';
import 'platform/open_file.dart';

/// 扩展名 → 类型与图标。
(String, IconData) fileType(String name) {
  final ext = name.contains('.') ? name.split('.').last.toLowerCase() : '';
  return switch (ext) {
    'docx' || 'doc' || 'odt' || 'rtf' => ('Word 文档', Icons.description_outlined),
    'xlsx' || 'xls' || 'ods' => ('Excel 工作簿', Icons.table_chart_outlined),
    'pptx' || 'ppt' || 'odp' => ('演示文稿', Icons.slideshow_outlined),
    'pdf' => ('PDF', Icons.picture_as_pdf_outlined),
    'csv' || 'tsv' => ('CSV 表格', Icons.grid_on_outlined),
    'md' || 'markdown' => ('Markdown', Icons.notes_outlined),
    'html' || 'htm' => ('HTML 网页', Icons.web_outlined),
    'json' => ('JSON', Icons.data_object_outlined),
    'zip' || '7z' || 'gz' || 'tar' => ('压缩包', Icons.folder_zip_outlined),
    _ => (ext.isEmpty ? '文件' : '${ext.toUpperCase()} 文件', Icons.insert_drive_file_outlined),
  };
}

String fileSize(num n) => n >= 1048576 ? '${(n / 1048576).toStringAsFixed(1)} MB' : n >= 1024 ? '${(n / 1024).round()} KB' : '${n.toInt()} 字节';

/// 能预览的：运行基座的文档读取认得的格式。
bool previewable(String name) => RegExp(r'\.(docx|xlsx|pptx|pdf|odt|ods|odp|epub|csv|tsv|md|markdown|html|htm|json|txt|rtf)$', caseSensitive: false).hasMatch(name);

/// 把预览文字里的 Excel 工作表（「--- 工作表：名字（n 行，制表符分隔）---」）拆成表格；不是这种格式返回空。
List<(String, List<List<String>>)> sheetsOf(String text) {
  final out = <(String, List<List<String>>)>[];
  for (final m in RegExp(r'--- 工作表：(.+?)（\d+ 行，制表符分隔）---\n([\s\S]*?)(?=\n\n--- 工作表：|$)').allMatches(text)) {
    out.add((m.group(1)!, [for (final l in m.group(2)!.split('\n')) if (l.isNotEmpty) l.split('\t')]));
  }
  return out;
}

class FileCard extends StatelessWidget {
  final Map file;
  final String? body; // 这条消息在哪具身体上（别的身体上做的那一轮，文件在那边）
  const FileCard(this.file, {super.key, this.body});

  /// 取内容与预览（测试里替换）。
  static Future<Uint8List> Function(String rel) fetch = (rel) => api.download(rel);
  static Future<Map> Function(String rel) preview = (rel) => api.call<Map>('uploads.preview', {'rel': rel});

  String get name => '${file['name'] ?? '文件'}';
  String get rel => '${file['rel'] ?? ''}';

  String _why(Object e) => e is RpcError && e.code == 'NOT_HERE' || '$e'.contains('不在这具身体上')
      ? '这个文件在${body != null && body!.isNotEmpty ? ' $body ' : '另一具身体'}上，在连着那具身体的控制台里下载'
      : '$e';

  Future<void> _download(BuildContext context) async {
    try {
      final bytes = await fetch(rel);
      final saved = await FilePicker.saveFile(fileName: name, bytes: bytes);
      if (saved != null && context.mounted) toast(context, '已保存 $name');
    } catch (e) { if (context.mounted) toast(context, '没能下载：${_why(e)}'); }
  }

  Future<void> _open(BuildContext context) async {
    try {
      if (!await openWithSystem(name, await fetch(rel)) && context.mounted) toast(context, '没有找到能打开 $name 的应用，可以先下载');
    } catch (e) { if (context.mounted) toast(context, '没能打开：${_why(e)}'); }
  }

  Future<void> _preview(BuildContext context) async {
    showDialog(context: context, builder: (x) => _PreviewDialog(name: name, load: () => preview(rel), why: _why));
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme, tt = Theme.of(context).textTheme;
    final (type, icon) = fileType(name);
    final mine = file['by'] == 'agent';
    Widget btn(String tip, IconData i, VoidCallback f) => IconButton(tooltip: tip, onPressed: f, icon: Icon(i, size: 18), visualDensity: VisualDensity.compact);
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 380),
      child: Material(
        color: mine ? cs.secondaryContainer.withValues(alpha: 0.5) : cs.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: rel.isEmpty ? null : () => previewable(name) ? _preview(context) : _download(context),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
            child: Row(children: [
              Icon(icon, size: 30, color: cs.primary),
              const SizedBox(width: 10),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(name, maxLines: 2, overflow: TextOverflow.ellipsis, style: tt.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                Text('$type · ${fileSize(file['size'] as num? ?? 0)}', style: tt.labelSmall?.copyWith(color: cs.onSurfaceVariant)),
              ])),
              if (rel.isNotEmpty && previewable(name)) btn('预览', Icons.visibility_outlined, () => _preview(context)),
              if (rel.isNotEmpty && canOpenWithSystem) btn('打开', Icons.open_in_new, () => _open(context)),
              if (rel.isNotEmpty) btn('下载', Icons.download_outlined, () => _download(context)),
            ]),
          ),
        ),
      ),
    );
  }
}

class _PreviewDialog extends StatefulWidget {
  final String name;
  final Future<Map> Function() load;
  final String Function(Object) why;
  const _PreviewDialog({required this.name, required this.load, required this.why});
  @override
  State<_PreviewDialog> createState() => _PreviewDialogState();
}

class _PreviewDialogState extends State<_PreviewDialog> {
  late final Future<Map> data = widget.load();

  Widget _sheets(List<(String, List<List<String>>)> sheets, ColorScheme cs) => DefaultTabController(
        length: sheets.length,
        child: Column(children: [
          if (sheets.length > 1) TabBar(isScrollable: true, tabs: [for (final s in sheets) Tab(text: s.$1)]),
          Expanded(child: TabBarView(children: [
            for (final s in sheets)
              SingleChildScrollView(child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: Table(
                defaultColumnWidth: const IntrinsicColumnWidth(),
                border: TableBorder.all(color: cs.outlineVariant, width: 0.5),
                children: [
                  for (final (i, r) in s.$2.take(30).indexed)
                    TableRow(
                      decoration: i == 0 ? BoxDecoration(color: cs.surfaceContainerHighest) : null,
                      children: [for (var c = 0; c < s.$2.take(30).fold<int>(0, (n, r) => r.length > n ? r.length : n); c++) Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4), child: Text(c < r.length ? r[c] : '', style: TextStyle(fontWeight: i == 0 ? FontWeight.w600 : null)))],
                    ),
                ],
              ))),
          ])),
        ]),
      );

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return AlertDialog(
      title: Text(widget.name, maxLines: 2, overflow: TextOverflow.ellipsis),
      content: SizedBox(
        width: 640, height: 420,
        child: FutureBuilder<Map>(
          future: data,
          builder: (context, s) {
            if (s.hasError) return Center(child: Text('没能预览：${widget.why(s.error!)}'));
            if (!s.hasData) return const Center(child: CircularProgressIndicator());
            final text = '${s.data!['text'] ?? ''}', total = (s.data!['total'] as num?)?.toInt() ?? text.length;
            final sheets = sheetsOf(text);
            return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${s.data!['kind'] ?? ''}${total > text.length ? ' · 只显示开头 ${text.length} / $total 字' : ''}', style: Theme.of(context).textTheme.labelSmall?.copyWith(color: cs.outline)),
              const SizedBox(height: 6),
              Expanded(child: sheets.isNotEmpty ? _sheets(sheets, cs) : SingleChildScrollView(child: SelectableText(text.isEmpty ? '（没有可显示的文字）' : text))),
            ]);
          },
        ),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭'))],
    );
  }
}
