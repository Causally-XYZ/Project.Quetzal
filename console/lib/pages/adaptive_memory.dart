// 对话记忆：使用现有集中处理 / 查询接口，补充原话进入同一事实写入路径。
import 'package:flutter/material.dart';
import '../api.dart';
import '../markdown.dart';
import '../widgets.dart';
import 'memory_backups.dart';

class AdaptiveMemoryPage extends StatefulWidget {
  const AdaptiveMemoryPage({super.key});
  @override
  State<AdaptiveMemoryPage> createState() => _AdaptiveMemoryState();
}

class _AdaptiveMemoryState extends State<AdaptiveMemoryPage> {
  final query = TextEditingController(), correction = TextEditingController();
  Map? status, reading;
  bool loading = false, saving = false, searching = false;
  String? error, saved, retryResult;
  int epoch = 0, searchEpoch = 0;
  late String scope;
  String get currentScope => '${api.current?.id}:${(api.status['agent'] as Map?)?['id']}:${api.status['body']}';
  bool get online => api.conn == Conn.online;
  @override
  void initState() { super.initState(); scope = currentScope; api.addListener(_connection); _load(); }
  @override
  void dispose() { api.removeListener(_connection); query.dispose(); correction.dispose(); super.dispose(); }
  void _connection() {
    if (scope != currentScope || !online) {
      epoch++; searchEpoch++; scope = currentScope;
      setState(() { status = null; reading = null; error = null; saved = null; retryResult = null; loading = saving = searching = false; });
      query.clear(); correction.clear();
      if (online) _load();
    } else if (status == null && !loading) {
      _load();
    } else {
      final fresh = api.status['adaptiveMemory'];
      if (fresh is Map) setState(() => status = fresh);
    }
  }
  bool valid(int token) => mounted && token == epoch && scope == currentScope && online;
  Future<void> _load() async {
    if (!online || loading) return;
    final token = ++epoch;
    setState(() { loading = true; error = null; reading = null; searching = false; });
    try {
      final r = await api.call<Map>('memory.adaptive.status');
      if (valid(token)) setState(() => status = r);
    } catch (e) { if (valid(token)) setState(() => error = '$e'); }
    finally { if (valid(token)) setState(() => loading = false); }
  }
  Future<void> _configure({bool? enabled, bool? semantic, bool? research, String? host}) async {
    if (!online || saving || status == null) return;
    final token = epoch, s = status!, sem = (s['semantic'] as Map?) ?? {};
    setState(() { saving = true; error = null; reading = null; searching = false; });
    searchEpoch++;
    try {
      final r = await api.call<Map>('memory.adaptive.configure', {
        'enabled': enabled ?? s['enabled'] == true, 'hostBody': host ?? s['hostBody'] ?? '',
        'semantic': semantic ?? sem['enabled'] == true,
        'research': research ?? (sem['research'] as Map?)?['enabled'] == true,
      });
      if (valid(token)) { api.status['adaptiveMemory'] = r; setState(() => status = r); }
    } catch (e) { if (valid(token)) setState(() => error = '$e'); }
    finally { if (valid(token)) setState(() => saving = false); }
  }
  Future<void> _search() async {
    if (!online || query.text.trim().isEmpty || status?['enabled'] != true) return;
    final token = epoch, request = ++searchEpoch;
    setState(() { searching = true; error = null; reading = null; });
    try {
      final semantic = (status?['semantic'] as Map?)?['enabled'] == true;
      final r = await api.call<Map>(semantic ? 'memory.adaptive.semantic.query' : 'memory.adaptive.query', {'query': query.text.trim()});
      if (valid(token) && request == searchEpoch) setState(() => reading = r);
    } catch (e) { if (valid(token) && request == searchEpoch) setState(() => error = '$e'); }
    finally { if (valid(token) && request == searchEpoch) setState(() => searching = false); }
  }
  Future<void> _remember() async {
    if (!online || saving || correction.text.trim().isEmpty || status?['enabled'] != true) return;
    final token = epoch;
    searchEpoch++;
    setState(() { saving = true; saved = null; error = null; reading = null; searching = false; });
    try {
      final r = await api.call<String>('editMemory', {'target': 'user', 'action': 'add', 'remember': true, 'content': correction.text.trim()});
      if (valid(token)) setState(() { saved = r; correction.clear(); reading = null; });
    } catch (e) { if (valid(token)) setState(() => error = '$e'); }
    finally { if (valid(token)) setState(() => saving = false); }
  }
  Future<void> _retryFailed() async {
    if (!online || saving || status?['local'] != true || status?['stopped'] == true) return;
    final token = epoch;
    searchEpoch++;
    setState(() { saving = true; error = null; retryResult = null; reading = null; searching = false; });
    try {
      final jobs = await api.call<List>('memory.adaptive.jobs', {'retryable': true});
      var queued = 0;
      for (final job in jobs.take(100)) {
        if (!valid(token)) return;
        if (job is! Map || job['id'] is! String || job['attempts'] is! int) throw StateError('失败任务格式不完整，请刷新。');
        if (await api.call<bool>('memory.adaptive.retry', {'id': job['id'], 'attempts': job['attempts']})) queued++;
      }
      if (valid(token)) setState(() => retryResult = queued == 0 ? '没有可重试的失败处理任务。' : '已提交 $queued 项重试；不代表理解或同步完成。');
    } catch (e) { if (valid(token)) setState(() => error = '$e'); }
    finally { if (valid(token)) setState(() => saving = false); }
    if (valid(token)) await _load();
  }
  Future<void> _source(Map root) async {
    final request = api.call<Map>('memory.adaptive.source', {'id': root['id'], 'hash': root['hash']});
    final sourceScope = scope;
    await showSheet(context, (context, scroll) => SingleChildScrollView(controller: scroll, padding: const EdgeInsets.all(20), child:
      ListenableBuilder(listenable: api, builder: (context, _) => sourceScope != currentScope || !online
        ? const Text('连接已变化，请关闭后重新查看来源。')
        : FutureBuilder<Map>(future: request, builder: (context, snapshot) {
          if (snapshot.hasError) return Text('来源暂时不可用：${snapshot.error}');
          if (!snapshot.hasData) return const Center(child: CircularProgressIndicator());
          final r = snapshot.data!, source = (r['source'] as Map?) ?? {}, view = (r['reading'] as Map?) ?? {};
          if (r['status'] != 'ready') return Text(r['status'] == 'changed' ? '原文已变化，请重新搜索。' : '本机暂时无法核对这条来源。');
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('原始发言 · ${source['recordedAt'] ?? '时间未知'}', style: Theme.of(context).textTheme.titleMedium),
            const Text('以下是历史原话；后续理解可能已修订。时间为记录时间。'),
            RichMarkdown('${source['text']}'),
            if (source['truncated'] == true) const Text('原文较长，此处仅展示开头。'),
            if ((view['notices'] as List? ?? []).isNotEmpty) ...[
              const Divider(), const Text('本机已知的当前理解'),
              for (final notice in view['notices']) Padding(padding: const EdgeInsets.only(top: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(_evidenceLabel('${notice['status']}')),
                RichMarkdown('${notice['current']?['text'] ?? '这项理解目前不可用，请以原话和后续纠正为准。'}'),
              ])),
            ],
          ]);
        })),
    ));
  }
  Widget _item(Map item) {
    final ambiguous = item['kind'] == 'mention';
    final roots = (item['roots'] as List?) ?? [];
    final assumptions = <String>{for (final group in (item['supports'] as List?) ?? []) for (final a in (group['assumptions'] as List?) ?? []) '$a'};
    final world = (item['realm'] as Map?)?['world'];
    return Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(ambiguous ? '指代待澄清' : item['nature'] == 'reported' ? '有来源的陈述' : '推测 · ${_evidenceLabel('${item['status']}')}', style: Theme.of(context).textTheme.labelLarge),
      if (world != null) Text({'real': '现实语境', 'fiction': '故事语境', 'hypothetical': '假设语境', 'unknown': '语境待确认'}[world] ?? '语境待确认'),
      RichMarkdown(ambiguous ? '“${item['anchor']?['quote'] ?? ''}”可能指：${((item['candidates'] as List?) ?? []).map((c) => c['name']).join('、')}${item['unknown'] == true ? '，也可能是其他对象' : ''}' : '${item['text']}'),
      for (final a in assumptions) Text('尚待核实：$a'),
      Wrap(spacing: 8, children: [for (var i = 0; i < roots.length; i++) TextButton(onPressed: () => _source(roots[i] as Map), child: Text('来源 ${i + 1}'))]),
    ])));
  }
  @override
  Widget build(BuildContext context) {
    final s = status ?? {}, sem = (s['semantic'] as Map?) ?? {};
    final enabled = s['enabled'] == true, host = '${s['hostBody'] ?? ''}';
    final mesh = (api.status['mesh'] as Map?) ?? {};
    final hosts = <String>{if ('${api.status['body'] ?? ''}'.isNotEmpty) '${api.status['body']}', if (host.isNotEmpty) host,
      for (final p in (mesh['peers'] as List?) ?? []) if (p['body'] is String && p['kind'] != 'bridge') '${p['body']}'};
    return PageFrame(title: '对话记忆', actions: [IconButton(tooltip: '刷新', onPressed: online && !loading && !saving ? _load : null, icon: const Icon(Icons.refresh))], body:
      ListView(padding: const EdgeInsets.all(12), children: [
        if (!online) const Text('连接已断开，重连后再查看记忆。'),
        if (loading) const LinearProgressIndicator(),
        if (error != null) SelectableText(error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
        if (status != null) ...[
          ListTile(leading: const Icon(Icons.save_alt), title: const Text('记忆备份'), trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const MemoryBackupsPage()))),
          Section('记忆处理', [
            DropdownButtonFormField<String>(key: ValueKey(host), initialValue: hosts.contains(host) ? host : null, isExpanded: true,
              decoration: const InputDecoration(labelText: '处理记忆的设备'),
              items: hosts.map((h) => DropdownMenuItem(value: h, child: Text(h, overflow: TextOverflow.ellipsis))).toList(),
              onChanged: saving ? null : (h) { if (h != null) _configure(host: h); }),
            SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('使用对话记忆'), value: enabled,
              onChanged: saving || host.isEmpty ? null : (v) => _configure(enabled: v)),
            SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('整理与修正'), value: sem['enabled'] == true,
              onChanged: saving || !enabled ? null : (v) => _configure(semantic: v)),
            SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('空闲时探索关联'), value: (sem['research'] as Map?)?['enabled'] == true,
              onChanged: saving || !enabled || sem['enabled'] != true ? null : (v) => _configure(research: v)),
            Text(adaptiveStatusLabel(s)),
            if (enabled && s['local'] == true) ...[
              TextButton(onPressed: saving || s['stopped'] == true ? null : _retryFailed, child: const Text('重试失败的处理任务')),
              const Text('请先检查模型或配置问题。每项只追加一次尝试；不会重做已接受的结果或修复发布失败。'),
              if (retryResult != null) Text(retryResult!),
            ],
            if (enabled) const Text('同一 agent 的可访问对话会关联；新事实由此保存和纠正，旧资料保留作历史参考。'),
          ]),
          if (enabled) ...[
            Section('补充或纠正', [
              TextField(key: const Key('memory-correction'), controller: correction, minLines: 2, maxLines: 5, maxLength: 8000,
                decoration: const InputDecoration(hintText: '说明是哪件事、哪里记错了，以及正确的情况', border: OutlineInputBorder())),
              FilledButton(onPressed: saving ? null : _remember, child: const Text('保存原话')),
              if (saved != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(saved!)),
            ]),
            Section('查找记忆', [
              TextField(key: const Key('memory-query'), controller: query, maxLength: 8000, onSubmitted: (_) => _search(),
                decoration: const InputDecoration(hintText: '人物、事情或主题', border: OutlineInputBorder())),
              TextButton.icon(onPressed: searching ? null : _search, icon: const Icon(Icons.search), label: const Text('搜索')),
              if (searching) const LinearProgressIndicator(),
              if (reading != null && reading!['status'] != 'ready') const Text('暂时无法读取记忆，可能尚未同步或处理主机不可用。'),
              if (reading?['status'] == 'ready') ...[
                const Text('本次检索快照；有来源不等于已经核实，也不代表所有设备已同步。'),
                if (((reading!['items'] ?? reading!['observations']) as List? ?? []).isEmpty) const Text('没有找到可用记忆。'),
                for (final item in (reading!['items'] as List?) ?? []) _item(item as Map),
                for (final source in (reading!['observations'] as List?) ?? []) Card(child: ListTile(title: RichMarkdown('${source['text']}'), subtitle: const Text('历史原话'), onTap: () => _source(source as Map))),
              ],
            ]),
          ],
        ],
      ]));
  }
}

String _evidenceLabel(String status) => {'supported': '当前有依据', 'conditional': '仍有未核实前提', 'ambiguous': '指代待澄清', 'unsupported': '依据不足', 'withdrawn': '已撤回', 'conflicted': '存在冲突', 'unavailable': '暂不可核对'}[status] ?? '待核对';

String adaptiveStatusLabel(Map s) {
  if (s['enabled'] != true) return '尚未启用';
  if (s['stopped'] == true) return '已急停';
  if (s['running'] != true) return '本机处理未启动';
  if (s['local'] != true) return '由 ${s['hostBody']} 处理；此处没有中心任务状态。';
  if (s['error'] != null) return '处理暂时不可用，请刷新查看。';
  final sem = (s['semantic'] as Map?) ?? {};
  if (sem['state'] == 'unconfigured') return '请先在控制台配置模型。';
  final queues = [s['queue'], sem['queue'], (sem['research'] as Map?)?['queue']].whereType<Map>();
  var pending = 0, failed = 0;
  for (final queue in queues) {
    final counts = (queue['counts'] as Map?) ?? {};
    pending += ((counts['queued'] as num?)?.toInt() ?? 0) + ((counts['running'] as num?)?.toInt() ?? 0);
    failed += (counts['failed'] as num?)?.toInt() ?? 0;
  }
  if (failed > 0) return '有 $failed 项处理失败；原始对话仍保留。';
  if (pending > 0) return '有 $pending 项正在处理或等待处理。';
  return sem['enabled'] == true ? '当前未见待处理任务；不代表所有设备已同步。' : '仅保存与检索原话，尚未开启整理。';
}
