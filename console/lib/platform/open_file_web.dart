import 'dart:typed_data';

/// 网页版没有「用系统应用打开」：直接下载。
const bool canOpenWithSystem = false;

Future<bool> openWithSystem(String name, Uint8List bytes) async => false;
