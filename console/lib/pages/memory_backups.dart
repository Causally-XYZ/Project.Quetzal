import 'package:flutter/material.dart';
import '../api.dart';
import '../widgets.dart';

class MemoryBackupsPage extends StatefulWidget {
  const MemoryBackupsPage({super.key});
  @override
  State<MemoryBackupsPage> createState() => _MemoryBackupsState();
}

class _MemoryBackupsState extends State<MemoryBackupsPage> {
  List<Map> backups = [];
  bool busy = false;
  String? error, message;
  int epoch = 0;
  late String scope;
  late bool wasOnline;
  String get currentScope => '${api.current?.id}:${(api.status['agent'] as Map?)?['id']}:${api.status['body']}';
  bool get online => api.conn == Conn.online;
  bool valid(int token) => mounted && token == epoch && scope == currentScope && online;
  @override
  void initState() { super.initState(); scope = currentScope; wasOnline = online; api.addListener(_connection); _run('list'); }
  @override
  void dispose() { api.removeListener(_connection); super.dispose(); }
  void _connection() {
    if (scope != currentScope || wasOnline != online) {
      epoch++; scope = currentScope; wasOnline = online;
      setState(() { backups = []; busy = false; error = message = null; });
      if (online) _run('list');
    }
  }
  Future<void> _run(String action, [String? id]) async {
    if (!online || busy) return;
    final token = ++epoch;
    setState(() { busy = true; error = message = null; });
    try {
      if (action != 'list') {
        await api.call<Map>('memory.backup.$action', id == null ? {} : {'id': id});
        if (!valid(token)) return;
        setState(() => message = action == 'create' ? '备份已创建并通过文件与数据库完整性检查。' : '这份备份的完整性检查通过。');
      }
      final result = await api.call<List>('memory.backup.list');
      if (valid(token)) setState(() => backups = result.whereType<Map>().toList().reversed.toList());
    } catch (e) {
      if (valid(token)) setState(() => error = '$e\n若连接中断或等待超时，请刷新列表核对结果。');
    } finally { if (valid(token)) setState(() => busy = false); }
  }
  @override
  Widget build(BuildContext context) {
    final body = '${api.status['body'] ?? ''}';
    final host = (api.status['adaptiveMemory'] as Map?)?['hostBody'];
    return PageFrame(title: '记忆备份', actions: [IconButton(tooltip: '刷新备份', onPressed: online && !busy ? () => _run('list') : null, icon: const Icon(Icons.refresh))], body:
      ListView(padding: const EdgeInsets.all(16), children: [
        Text('所连接设备：$body', style: Theme.of(context).textTheme.titleMedium),
        const Text('保存这台设备已有的对话、认识修订、灵魂历史与本机附件，不代表所有设备都已同步。'),
        if (host is String && host.isNotEmpty && host != body) Text('集中处理记忆的设备是 $host；建议连接该设备，待同步完成后创建备份。'),
        const SizedBox(height: 8),
        const Text('备份包含私人记忆，不含模型配置和设备密钥。文件夹保存在所连接设备上；请另行复制到其他存储，才能应对该设备损坏。'),
        const Text('创建或检查较大的备份时，这台设备可能短暂忙碌，请在空闲时操作。恢复请使用目标设备上的 quetzal restore 命令，指定备份文件夹和一个尚不存在的新家目录；图形恢复入口尚未提供。'),
        const SizedBox(height: 12),
        FilledButton.icon(onPressed: online && !busy ? () => _run('create') : null, icon: const Icon(Icons.save_alt), label: const Text('创建本机备份')),
        if (!online) const Text('连接已断开，重连后再查看备份。'),
        if (busy) const LinearProgressIndicator(),
        if (message != null) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(message!)),
        if (error != null) SelectableText(error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
        for (final b in backups) Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (b['readable'] != true) const Text('这份备份的清单无法读取。') else ...[
            Text('${b['createdAt']} · ${b['body']}'),
            Text('${b['files']} 个文件 · ${((b['bytes'] as num) / 1048576).toStringAsFixed(1)} MB'),
            SelectableText('${b['directory']}'),
            const Text('列表仅显示清单；点击检查以核对当前文件。'),
          ],
          TextButton(onPressed: online && !busy ? () => _run('verify', '${b['id']}') : null, child: const Text('检查完整性')),
        ]))),
      ]));
  }
}
