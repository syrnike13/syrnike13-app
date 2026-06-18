class SyrnikeFileAsset {
  const SyrnikeFileAsset({
    required this.id,
    this.tag,
    this.filename,
    this.contentType,
  });

  factory SyrnikeFileAsset.fromJson(Object? raw, {String? fallbackTag}) {
    if (raw is String) {
      return SyrnikeFileAsset(id: raw, tag: fallbackTag);
    }

    final json = raw is Map<String, Object?> ? raw : const <String, Object?>{};
    return SyrnikeFileAsset(
      id: (json['_id'] ?? json['id']) as String? ?? '',
      tag: json['tag'] as String? ?? fallbackTag,
      filename: json['filename'] as String?,
      contentType: json['content_type'] as String?,
    );
  }

  final String id;
  final String? tag;
  final String? filename;
  final String? contentType;

  bool get isEmpty => id.trim().isEmpty;
  bool get isNotEmpty => !isEmpty;

  String url(String mediaUrl, {required String fallbackTag}) {
    final base = mediaUrl.endsWith('/')
        ? mediaUrl.substring(0, mediaUrl.length - 1)
        : mediaUrl;
    final bucket = tag?.trim().isNotEmpty == true ? tag!.trim() : fallbackTag;
    return '$base/$bucket/$id';
  }
}

SyrnikeFileAsset? parseSyrnikeFileAsset(
  Object? raw, {
  required String fallbackTag,
}) {
  if (raw == null) return null;
  final asset = SyrnikeFileAsset.fromJson(raw, fallbackTag: fallbackTag);
  return asset.isEmpty ? null : asset;
}
