import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/api.dart';
import 'package:quetzal_console/pages/adaptive_memory.dart';

Map status({bool local = true}) => {'enabled': true, 'hostBody': 'center', 'local': local, 'running': true, 'stopped': false,
  'queue': {'counts': {'queued': 0}}, 'semantic': {'enabled': true, 'state': 'idle', 'queue': {'counts': {'queued': 2}}, 'research': {'enabled': true}}};
Map reading(String text) => {'status': 'ready', 'items': [{'kind': 'claim', 'status': 'conditional', 'nature': 'hypothesis',
  'realm': {'world': 'fiction'}, 'text': text, 'supports': [{'assumptions': ['末班车没有临时调整']}], 'roots': [{'id': 1, 'hash': 'abc'}]}]};

void main() {
  setUp(() { api.conn = Conn.online; api.status = {'body': 'center', 'agent': {'id': 'synthetic'}}; });
  tearDown(() { api.fake = null; api.conn = Conn.unpaired; api.status = {}; });
  test('卫星不把空队列当中心已完成，任务与原文状态不混淆', () {
    expect(adaptiveStatusLabel(status(local: false)), contains('没有中心任务状态'));
    expect(adaptiveStatusLabel(status()), contains('2 项'));
    expect(adaptiveStatusLabel({'enabled': false}), '尚未启用');
  });
  for (final width in [390.0, 1100.0]) {
    testWidgets('来源、假设和自然纠正走生产接口，宽度 $width', (t) async {
      t.view.physicalSize = Size(width, 1800); t.view.devicePixelRatio = 1;
      addTearDown(t.view.resetPhysicalSize); addTearDown(t.view.resetDevicePixelRatio);
      Map? submitted;
      api.fake = (method, params) async {
        if (method == 'memory.adaptive.status') return status();
        if (method == 'memory.adaptive.semantic.query') { return reading('故事人物可能错过公交'); }
        if (method == 'memory.adaptive.source') {
          return {'status': 'ready', 'source': {'text': '原始交通公告', 'recordedAt': '2026-01-01T00:00:00Z'},
            'reading': {'notices': [{'status': 'supported', 'current': {'text': '公告日期已纠正'}}]}};
        }
        if (method == 'editMemory') { submitted = params; return '已保存原话；尚不代表理解或同步完成。'; }
        throw StateError('意外调用 $method');
      };
      await t.pumpWidget(const MaterialApp(home: AdaptiveMemoryPage())); await t.pumpAndSettle();
      await t.enterText(find.byKey(const Key('memory-query')), '交通');
      await t.ensureVisible(find.text('搜索')); await t.tap(find.text('搜索')); await t.pumpAndSettle();
      expect(find.textContaining('尚待核实：末班车没有临时调整'), findsOneWidget);
      await t.ensureVisible(find.text('来源 1')); await t.tap(find.text('来源 1')); await t.pumpAndSettle();
      expect(find.textContaining('原始交通公告'), findsOneWidget); expect(find.textContaining('公告日期已纠正'), findsOneWidget);
      Navigator.of(t.element(find.textContaining('原始交通公告'))).pop(); await t.pumpAndSettle();
      await t.ensureVisible(find.byKey(const Key('memory-correction'))); await t.enterText(find.byKey(const Key('memory-correction')), '日期应该是下周');
      await t.ensureVisible(find.text('保存原话')); await t.tap(find.text('保存原话')); await t.pumpAndSettle();
      expect(submitted, {'target': 'user', 'action': 'add', 'remember': true, 'content': '日期应该是下周'});
      expect(find.textContaining('尚不代表理解或同步完成'), findsOneWidget);
      expect(find.textContaining('故事人物可能错过公交'), findsNothing); expect(t.takeException(), isNull);
    });
  }
  testWidgets('新查询和刷新后拒绝迟到的旧查询，失败不显示为空结果', (t) async {
    t.view.physicalSize = const Size(1100, 1800); t.view.devicePixelRatio = 1;
    addTearDown(t.view.resetPhysicalSize); addTearDown(t.view.resetDevicePixelRatio);
    final pending = <Completer<Map>>[];
    api.fake = (method, params) async {
      if (method == 'memory.adaptive.status') return status();
      if (method == 'memory.adaptive.semantic.query') { final c = Completer<Map>(); pending.add(c); return c.future; }
      throw StateError(method);
    };
    await t.pumpWidget(const MaterialApp(home: AdaptiveMemoryPage())); await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('memory-query')), '旧查询');
    await t.tap(find.text('搜索')); await t.pump();
    await t.enterText(find.byKey(const Key('memory-query')), '新查询');
    await t.testTextInput.receiveAction(TextInputAction.done); await t.pump();
    pending[1].complete(reading('新结果')); await t.pumpAndSettle();
    pending[0].complete(reading('旧结果')); await t.pumpAndSettle();
    expect(find.text('新结果'), findsOneWidget); expect(find.text('旧结果'), findsNothing);
    await t.tap(find.byTooltip('刷新')); await t.pumpAndSettle();
    expect(find.text('新结果'), findsNothing);
    await t.tap(find.text('搜索')); await t.pump();
    pending[2].complete({'status': 'unavailable', 'items': []}); await t.pumpAndSettle();
    expect(find.textContaining('暂时无法读取记忆'), findsOneWidget); expect(find.text('没有找到可用记忆。'), findsNothing);
  });
  for (final width in [390.0, 1100.0]) {
    testWidgets('中心重试使用已观察尝试次数，不将排队说成完成，宽度 $width', (t) async {
      t.view.physicalSize = Size(width, 1800); t.view.devicePixelRatio = 1;
      addTearDown(t.view.resetPhysicalSize); addTearDown(t.view.resetDevicePixelRatio);
      Map? submitted;
      api.fake = (method, params) async {
        if (method == 'memory.adaptive.status') return status();
        if (method == 'memory.adaptive.jobs') { expect(params, {'retryable': true}); return [{'id': 'failed-source', 'attempts': 5}]; }
        if (method == 'memory.adaptive.retry') { submitted = params; return true; }
        throw StateError(method);
      };
      await t.pumpWidget(const MaterialApp(home: AdaptiveMemoryPage())); await t.pumpAndSettle();
      await t.ensureVisible(find.text('重试失败的处理任务')); await t.tap(find.text('重试失败的处理任务')); await t.pumpAndSettle();
      expect(submitted, {'id': 'failed-source', 'attempts': 5});
      expect(find.text('已提交 1 项重试；不代表理解或同步完成。'), findsOneWidget);
      expect(t.takeException(), isNull);
    });
  }
  testWidgets('切换身份后迟到失败列表不能向新连接发起重试', (t) async {
    t.view.physicalSize = const Size(1100, 1800); t.view.devicePixelRatio = 1;
    addTearDown(t.view.resetPhysicalSize); addTearDown(t.view.resetDevicePixelRatio);
    final jobs = Completer<List>(); var retried = 0;
    api.fake = (method, params) async {
      if (method == 'memory.adaptive.status') return status();
      if (method == 'memory.adaptive.jobs') return jobs.future;
      if (method == 'memory.adaptive.retry') { retried++; return true; }
      throw StateError(method);
    };
    await t.pumpWidget(const MaterialApp(home: AdaptiveMemoryPage())); await t.pumpAndSettle();
    await t.ensureVisible(find.text('重试失败的处理任务')); await t.tap(find.text('重试失败的处理任务')); await t.pump();
    api.status = {'body': 'center', 'agent': {'id': 'different-agent'}}; api.notifyListeners(); await t.pumpAndSettle();
    jobs.complete([{'id': 'old-agent-task', 'attempts': 5}]); await t.pumpAndSettle();
    expect(retried, 0); expect(find.textContaining('已提交 1 项重试'), findsNothing);
  });
}
