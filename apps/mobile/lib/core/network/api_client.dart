import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/app_config.dart';

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(ref.watch(appConfigProvider));
});

class ApiClient {
  ApiClient(AppConfig config)
    : _dio = Dio(
        BaseOptions(
          baseUrl: config.apiUrl,
          connectTimeout: const Duration(seconds: 12),
          receiveTimeout: const Duration(seconds: 20),
          headers: const {Headers.acceptHeader: Headers.jsonContentType},
        ),
      );

  final Dio _dio;

  Future<T> get<T>(String path, {String? sessionToken}) {
    return request<T>(path, method: 'GET', sessionToken: sessionToken);
  }

  Future<T> post<T>(String path, {Object? body, String? sessionToken}) {
    return request<T>(
      path,
      method: 'POST',
      body: body,
      sessionToken: sessionToken,
    );
  }

  Future<T> request<T>(
    String path, {
    required String method,
    Object? body,
    String? sessionToken,
  }) async {
    try {
      final headers = <String, Object?>{};
      if (sessionToken != null) {
        headers['X-Session-Token'] = sessionToken;
      }
      if (body != null) {
        headers[Headers.contentTypeHeader] = Headers.jsonContentType;
      }

      final response = await _dio.request<Object?>(
        path,
        data: body,
        options: Options(method: method, headers: headers),
      );

      return response.data as T;
    } on DioException catch (error) {
      throw ApiException.fromDio(error);
    }
  }
}

class ApiException implements Exception {
  const ApiException(this.message, {required this.statusCode, this.body});

  factory ApiException.fromDio(DioException error) {
    final response = error.response;
    final body = response?.data;
    var message = error.message ?? 'Не удалось подключиться к API';

    if (body is Map<String, Object?>) {
      final typed = body['type'];
      final text = body['message'];
      if (typed is String && typed.isNotEmpty) {
        message = typed;
      } else if (text is String && text.isNotEmpty) {
        message = text;
      }
    }

    return ApiException(message, statusCode: response?.statusCode, body: body);
  }

  final String message;
  final int? statusCode;
  final Object? body;

  @override
  String toString() => message;
}
