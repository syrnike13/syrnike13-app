import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';

final voiceApiProvider = Provider<VoiceApi>((ref) {
  return VoiceApi(ref.watch(apiClientProvider));
});

class VoiceApi {
  const VoiceApi(this._client);

  final ApiClient _client;

  Future<String> resolveVoiceNodeName() async {
    try {
      final response = await _client.get<Object?>('/');
      if (response is Map<String, Object?>) {
        final features = response['features'];
        if (features is Map<String, Object?>) {
          final livekit = features['livekit'];
          if (livekit is Map<String, Object?>) {
            final nodes = livekit['nodes'];
            if (nodes is List<dynamic> && nodes.isNotEmpty) {
              final first = nodes.first;
              if (first is Map<String, Object?>) {
                final name = first['name'];
                if (name is String && name.isNotEmpty) return name;
              }
            }
          }
        }
      }
    } catch (_) {
      // Keep voice usable on old roots or transient API failures.
    }
    return 'worldwide';
  }
}
