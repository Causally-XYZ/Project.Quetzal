import 'dart:async';
import 'dart:convert';
import 'package:quetzal_console/api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/pages/providers.dart';

void main() {
  for (final width in [390.0, 1100.0]) {
    testWidgets('思考设置选择与恢复默认，宽度 $width 无溢出', (tester) async {
      tester.view.physicalSize = Size(width, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      String? level;
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: Padding(
        padding: const EdgeInsets.all(24), child: StatefulBuilder(builder: (context, setState) =>
          ModelThinkingField(value: level, onChanged: (value) => setState(() => level = value))),
      ))));
      expect(find.text('供应商默认'), findsOneWidget);
      await tester.tap(find.byType(DropdownButtonFormField<String>)); await tester.pumpAndSettle();
      await tester.tap(find.text('低').last); await tester.pumpAndSettle();
      expect(level, 'LOW'); expect(find.text('低'), findsOneWidget);
      await tester.tap(find.byType(DropdownButtonFormField<String>)); await tester.pumpAndSettle();
      await tester.tap(find.text('供应商默认').last); await tester.pumpAndSettle();
      expect(level, isNull); expect(tester.takeException(), isNull);
    });
  }
  testWidgets('完整编辑器独立测试按钮；修改配置后拒绝迟到结果，保存和放弃保持一致', (t) async {
    t.view.physicalSize = const Size(390, 1100); t.view.devicePixelRatio = 1;
    addTearDown(t.view.resetPhysicalSize); addTearDown(t.view.resetDevicePixelRatio);
    final semantics = t.ensureSemantics();
    try {
      Map saved = {'providers': [{'id': 'p', 'catalogId': 'custom', 'name': '合成供应商',
        'baseUrl': 'https://example.invalid', 'protocol': 'google-generative-ai', 'enabled': true, 'keys': [],
        'models': [{'id': 'm', 'name': 'synthetic-model', 'enabled': true, 'context': 16000,
          'maxTokens': 4096, 'sortOrder': 0, 'thinkingLevel': 'LOW'}]}]};
      var version = 1;
      final pending = <Completer<Map>>[];
      api.fake = (method, params) async {
        if (method == 'catalog') return {'providers': []};
        if (method == 'saveProviders') { saved = jsonDecode(jsonEncode(params['config'])); version++; }
        if (method == 'providers' || method == 'saveProviders') return {'config': jsonDecode(jsonEncode(saved)), 'version': '$version'};
        if (method == 'testModel') { final c = Completer<Map>(); pending.add(c); return c.future; }
        throw StateError('未预期调用 $method');
      };
      addTearDown(() => api.fake = null);
      await t.pumpWidget(const MaterialApp(home: ProvidersEditor())); await t.pumpAndSettle();
      await t.tap(find.text('合成供应商')); await t.pumpAndSettle();
      expect(find.bySemanticsLabel(RegExp(r'^测试$')), findsOneWidget);
      await t.tap(find.widgetWithText(TextButton, '测试')); await t.pumpAndSettle();
      expect(pending.length, 1);
      Future<void> choose(String label) async {
        await t.tap(find.byType(ModelThinkingField)); await t.pumpAndSettle();
        await t.tap(find.text(label).last); await t.pumpAndSettle();
      }
      await choose('高');
      expect(find.text('先保存'), findsOneWidget);
      pending[0].complete({'ok': true, 'latencyMs': 8, 'message': '旧结果'}); await t.pumpAndSettle();
      expect(find.textContaining('旧结果'), findsNothing);
      await t.tap(find.widgetWithText(FilledButton, '保存')); await t.pumpAndSettle();
      await t.pump(const Duration(seconds: 5)); await t.pumpAndSettle(); // 等保存提示自动收起，再操作底栏。
      expect(saved['providers'][0]['models'][0]['thinkingLevel'], 'HIGH');
      await t.tap(find.widgetWithText(TextButton, '测试')); await t.pumpAndSettle();
      pending[1].complete({'ok': true, 'latencyMs': 4, 'message': '新结果'}); await t.pumpAndSettle();
      expect(find.textContaining('新结果'), findsOneWidget);
      await choose('中'); expect(find.textContaining('新结果'), findsNothing);
      await t.tap(find.widgetWithText(TextButton, '放弃')); await t.pumpAndSettle();
      await t.tap(find.text('确定')); await t.pumpAndSettle();
      expect(t.widget<ModelThinkingField>(find.byType(ModelThinkingField)).value, 'HIGH');
      expect(saved['providers'][0]['models'].length, 1);
      expect(t.takeException(), isNull);
    } finally { semantics.dispose(); }
  });

}
