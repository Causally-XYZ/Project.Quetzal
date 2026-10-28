import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/api.dart';
import 'package:quetzal_console/pages/memory_backups.dart';

void main() {
  setUp(() { api.conn = Conn.online; api.status = {'body': 'satellite', 'agent': {'id': 'synthetic'}, 'adaptiveMemory': {'hostBody': 'center'}}; });
  tearDown(() { api.fake = null; api.conn = Conn.unpaired; api.status = {}; });
  for (final width in [390.0, 1100.0]) {
    testWidgets('备份显示本机范围与真实校验结果，宽度 $width', (t) async {
      t.view.physicalSize = Size(width, 1800); t.view.devicePixelRatio = 1;
      addTearDown(t.view.resetPhysicalSize); addTearDown(t.view.resetDevicePixelRatio);
      var created = false;
      api.fake = (method, params) async {
        if (method == 'memory.backup.list') return created ? [{'id': 'test', 'createdAt': '2026-10-28T00:00:00Z', 'body': 'satellite', 'files': 5, 'bytes': 1024, 'directory': 'synthetic-backup-folder', 'readable': true}] : [];
        if (method == 'memory.backup.create') { created = true; return {'verified': true}; }
        if (method == 'memory.backup.verify') throw StateError('备份文件缺失、增加或内容损坏');
        throw StateError(method);
      };
      await t.pumpWidget(const MaterialApp(home: MemoryBackupsPage())); await t.pumpAndSettle();
      expect(find.textContaining('集中处理记忆的设备是 center'), findsOneWidget);
      await t.tap(find.text('创建本机备份')); await t.pumpAndSettle();
      expect(find.textContaining('备份已创建并通过'), findsOneWidget);
      expect(find.text('synthetic-backup-folder'), findsOneWidget);
      await t.ensureVisible(find.text('检查完整性')); await t.tap(find.text('检查完整性')); await t.pumpAndSettle();
      expect(find.textContaining('内容损坏'), findsOneWidget);
      expect(find.textContaining('备份已创建并通过'), findsNothing);
      expect(t.takeException(), isNull);
    });
  }
  testWidgets('切换身份后丢弃迟到的备份路径', (t) async {
    final pending = Completer<List>();
    api.fake = (method, params) => pending.future;
    await t.pumpWidget(const MaterialApp(home: MemoryBackupsPage())); await t.pump();
    api.status = {'body': 'other', 'agent': {'id': 'other'}};
    api.conn = Conn.unpaired; api.notifyListeners(); await t.pump();
    pending.complete([{'id': 'old', 'createdAt': 'old', 'body': 'satellite', 'files': 1, 'bytes': 1, 'directory': 'private-old-path', 'readable': true}]);
    await t.pumpAndSettle();
    expect(find.text('private-old-path'), findsNothing);
    expect(find.textContaining('连接已断开'), findsOneWidget);
    var refreshed = 0;
    api.fake = (method, params) async { expect(method, 'memory.backup.list'); refreshed++; return []; };
    api.conn = Conn.online; api.notifyListeners(); await t.pumpAndSettle();
    expect(refreshed, 1); expect(find.textContaining('连接已断开'), findsNothing);
  });
}
