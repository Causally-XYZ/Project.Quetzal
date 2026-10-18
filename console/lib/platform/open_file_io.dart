import 'dart:io';
import 'dart:typed_data';
import 'package:url_launcher/url_launcher.dart';

/// 这种形态能不能「用系统应用打开」：只有桌面版（安卓要经 FileProvider 才能把文件交给别的应用，这里不做，下载后在系统的文件里打开）。
final bool canOpenWithSystem = Platform.isLinux || Platform.isWindows || Platform.isMacOS;

/// 存到临时目录（quetzal-files/<文件名>，同名的覆盖，不越积越多）后交给系统默认的应用打开。返回是否打开了。
Future<bool> openWithSystem(String name, Uint8List bytes) async {
  if (!canOpenWithSystem) return false;
  final dir = Directory('${Directory.systemTemp.path}${Platform.pathSeparator}quetzal-files');
  await dir.create(recursive: true);
  final safe = name.replaceAll(RegExp(r'[\\/:*?"<>|\x00-\x1f]'), '_');
  final f = File('${dir.path}${Platform.pathSeparator}${safe.isEmpty ? 'file' : safe}');
  await f.writeAsBytes(bytes, flush: true);
  return launchUrl(Uri.file(f.path), mode: LaunchMode.externalApplication);
}
