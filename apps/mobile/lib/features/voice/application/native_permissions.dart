import 'package:permission_handler/permission_handler.dart';

Future<bool> ensureMicrophonePermission() async {
  final status = await Permission.microphone.request();
  return status.isGranted || status.isLimited;
}

Future<bool> ensureCameraPermission() async {
  final status = await Permission.camera.request();
  return status.isGranted || status.isLimited;
}
