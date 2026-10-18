// 附件的文件卡片（#18）：她生成的交付物显示名称、类型、大小与预览 / 下载；Excel 的预览是各工作表的前几行；文件在别的身体上时如实说明。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/api.dart';
import 'package:quetzal_console/file_card.dart';

Widget host(Widget w) => MaterialApp(home: Scaffold(body: Center(child: w)));

void main() {
  test('类型、大小与能不能预览', () {
    expect(fileType('季度报告.DOCX').$1, 'Word 文档');
    expect(fileType('预算.xlsx').$1, 'Excel 工作簿');
    expect(fileType('汇报.pptx').$1, '演示文稿');
    expect(fileType('报告.pdf').$1, 'PDF');
    expect(fileType('数据.json').$1, 'JSON');
    expect(fileType('无扩展名').$1, '文件');
    expect(fileType('a.bin').$1, 'BIN 文件');
    expect(fileSize(512), '512 字节');
    expect(fileSize(7608), '7 KB');
    expect(fileSize(3 * 1048576 + 1), '3.0 MB');
    expect(previewable('a.pdf'), isTrue);
    expect(previewable('a.zip'), isFalse);
  });

  test('预览文字里的 Excel 工作表拆成表格', () {
    final s = sheetsOf('--- 工作表：预算（3 行，制表符分隔）---\n项目\t金额\n房租\t3000\n合计\t=SUM(B2:B2)\n\n--- 工作表：备注（1 行，制表符分隔）---\n说明');
    expect(s.map((x) => x.$1), ['预算', '备注']);
    expect(s[0].$2, [['项目', '金额'], ['房租', '3000'], ['合计', '=SUM(B2:B2)']]);
    expect(s[1].$2, [['说明']]);
    expect(sheetsOf('普通文字'), isEmpty);
  });

  testWidgets('她生成的 xlsx：卡片显示名称、类型与大小，点「预览」看到工作表的前几行', (t) async {
    FileCard.preview = (rel) async {
      expect(rel, '2026-10-18/abc-预算表.xlsx');
      return {'name': '预算表.xlsx', 'kind': 'Excel', 'text': '--- 工作表：预算（2 行，制表符分隔）---\n项目\t金额\n房租\t3000', 'total': 40};
    };
    await t.pumpWidget(host(const FileCard({'name': '预算表.xlsx', 'rel': '2026-10-18/abc-预算表.xlsx', 'size': 7608, 'kind': 'file', 'by': 'agent'})));
    expect(find.text('预算表.xlsx'), findsOneWidget);
    expect(find.text('Excel 工作簿 · 7 KB'), findsOneWidget);
    expect(find.byTooltip('下载'), findsOneWidget);
    expect(find.byTooltip('预览'), findsOneWidget);
    await t.tap(find.byTooltip('预览'));
    await t.pumpAndSettle();
    expect(find.byType(Table), findsOneWidget);
    expect(find.text('房租'), findsOneWidget);
    expect(find.text('3000'), findsOneWidget);
    await t.tap(find.text('关闭'));
    await t.pumpAndSettle();
    expect(find.byType(Table), findsNothing);
  });

  testWidgets('PDF 的预览是开头的文字；文件在别的身体上时下载如实说明在哪', (t) async {
    FileCard.preview = (rel) async => {'name': '报告.pdf', 'kind': 'PDF', 'text': '季度报告\n这是中文段落', 'total': 9000};
    FileCard.fetch = (rel) async => throw RpcError('NOT_HERE', '这个文件不在这具身体上');
    await t.pumpWidget(host(const FileCard({'name': '报告.pdf', 'rel': 'x/报告.pdf', 'size': 124790, 'kind': 'file', 'by': 'agent'}, body: 'laptop')));
    expect(find.text('PDF · 122 KB'), findsOneWidget);
    await t.tap(find.text('报告.pdf')); // 点卡片本身：能预览的就预览
    await t.pumpAndSettle();
    expect(find.textContaining('这是中文段落'), findsOneWidget);
    expect(find.textContaining('只显示开头'), findsOneWidget);
    await t.tap(find.text('关闭'));
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('下载'));
    await t.pump();
    expect(find.textContaining('这个文件在 laptop 上'), findsOneWidget);
  });

  testWidgets('没有 rel 的附件（旧记录）只显示，不给下载', (t) async {
    await t.pumpWidget(host(const FileCard({'name': '旧.docx', 'size': 100})));
    expect(find.text('Word 文档 · 100 字节'), findsOneWidget);
    expect(find.byTooltip('下载'), findsNothing);
  });
}
