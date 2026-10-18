// 用系统应用打开一个文件（附件卡片的「打开」）：桌面版（Linux / Windows / macOS）存到临时目录后交给系统；手机与网页版没有这一步（手机下载后在系统的文件里打开，网页直接下载）。
export 'open_file_io.dart' if (dart.library.js_interop) 'open_file_web.dart';
