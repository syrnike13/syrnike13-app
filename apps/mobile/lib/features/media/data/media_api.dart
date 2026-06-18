import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/config/app_config.dart';
import '../../../core/network/api_client.dart';

final mediaApiProvider = Provider<MediaApi>((ref) {
  return MediaApi(ref.watch(appConfigProvider));
});

class MediaApi {
  MediaApi(AppConfig config)
    : _dio = Dio(
        BaseOptions(
          baseUrl: config.mediaUrl,
          connectTimeout: const Duration(seconds: 18),
          receiveTimeout: const Duration(seconds: 30),
          headers: const {Headers.acceptHeader: Headers.jsonContentType},
        ),
      );

  final Dio _dio;

  Future<String> uploadMediaFile({
    required String token,
    required String tag,
    required String filePath,
  }) async {
    try {
      final form = FormData.fromMap({
        'file': await MultipartFile.fromFile(filePath),
      });
      final response = await _dio.post<Object?>(
        '/$tag',
        data: form,
        options: Options(headers: {'X-Session-Token': token}),
      );
      final data = response.data;
      if (data is Map<String, Object?>) {
        final id = data['id'] ?? data['_id'];
        if (id is String && id.isNotEmpty) return id;
      }
      throw const ApiException(
        'Медиа-сервер не вернул id файла.',
        statusCode: null,
      );
    } on DioException catch (error) {
      throw ApiException.fromDio(error);
    }
  }
}
