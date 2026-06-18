part of '../mobile_discord_shell.dart';

void _showMicrophoneTestSheet(BuildContext context) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    builder: (_) => const _MicrophoneTestSheet(),
  );
}

class _MicrophoneTestSheet extends ConsumerStatefulWidget {
  const _MicrophoneTestSheet();

  @override
  ConsumerState<_MicrophoneTestSheet> createState() =>
      _MicrophoneTestSheetState();
}

class _MicrophoneTestSheetState extends ConsumerState<_MicrophoneTestSheet> {
  final AudioRecorder _recorder = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();

  StreamSubscription<Amplitude>? _amplitudeSubscription;
  Timer? _limitTimer;
  List<InputDevice> _devices = const [];
  double _level = 0;
  bool _recording = false;
  bool _playing = false;
  String? _recordingPath;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_loadDevices());
    _player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playing = false);
    });
  }

  @override
  void dispose() {
    _limitTimer?.cancel();
    unawaited(_amplitudeSubscription?.cancel());
    unawaited(_recorder.dispose());
    unawaited(_player.dispose());
    super.dispose();
  }

  Future<void> _loadDevices() async {
    try {
      if (!await _recorder.hasPermission()) return;
      final devices = await _recorder.listInputDevices();
      if (mounted) setState(() => _devices = devices);
    } catch (_) {
      // Device names are optional; recording remains available.
    }
  }

  Future<void> _start() async {
    final voice = ref.read(mobileVoiceControllerProvider);
    if (voice.connected) {
      setState(() {
        _error =
            'Во время звонка используется тот же микрофон. Проверьте индикатор отправки на экране голосового канала.';
      });
      return;
    }

    try {
      if (!await _recorder.hasPermission()) {
        setState(() => _error = 'Нет разрешения на использование микрофона.');
        return;
      }
      await _player.stop();
      final path =
          '${Directory.systemTemp.path}/syrnike-microphone-test-${DateTime.now().millisecondsSinceEpoch}.m4a';
      await _recorder.start(
        const RecordConfig(
          encoder: AudioEncoder.aacLc,
          bitRate: 96000,
          sampleRate: 48000,
          numChannels: 1,
          autoGain: true,
          echoCancel: true,
          noiseSuppress: true,
        ),
        path: path,
      );
      await _amplitudeSubscription?.cancel();
      _amplitudeSubscription = _recorder
          .onAmplitudeChanged(const Duration(milliseconds: 120))
          .listen((amplitude) {
            if (!mounted) return;
            setState(() => _level = _normalizeDb(amplitude.current));
          });
      _limitTimer?.cancel();
      _limitTimer = Timer(const Duration(seconds: 10), _stop);
      setState(() {
        _recording = true;
        _playing = false;
        _recordingPath = null;
        _error = null;
      });
    } catch (error) {
      if (mounted) {
        setState(() => _error = 'Не удалось запустить микрофон: $error');
      }
    }
  }

  Future<void> _stop() async {
    if (!_recording) return;
    _limitTimer?.cancel();
    await _amplitudeSubscription?.cancel();
    _amplitudeSubscription = null;
    try {
      final path = await _recorder.stop();
      if (!mounted) return;
      setState(() {
        _recording = false;
        _level = 0;
        _recordingPath = path;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _recording = false;
          _error = 'Не удалось сохранить тестовую запись: $error';
        });
      }
    }
  }

  Future<void> _play() async {
    final path = _recordingPath;
    if (path == null) return;
    try {
      await _player.play(DeviceFileSource(path));
      if (mounted) setState(() => _playing = true);
    } catch (error) {
      if (mounted) {
        setState(() => _error = 'Не удалось воспроизвести запись: $error');
      }
    }
  }

  double _normalizeDb(double db) {
    if (!db.isFinite) return 0;
    return ((db + 60) / 60).clamp(0, 1);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<SyrnikeThemeColors>()!;
    final voice = ref.watch(mobileVoiceControllerProvider);
    final level = voice.connected ? voice.microphoneLevel : _level;
    final status = voice.connected
        ? voice.microphonePublished
              ? level > 0.02
                    ? 'Сигнал поступает и отправляется в звонок'
                    : 'Микрофон опубликован. Скажите что-нибудь'
              : 'Микрофон не опубликован в звонок'
        : _recording
        ? 'Говорите обычным голосом'
        : _recordingPath == null
        ? 'Запишите короткую фразу'
        : 'Запись готова к прослушиванию';

    return _SheetContainer(
      heightFactor: 0.72,
      child: Column(
        children: [
          _SheetTitle(
            title: 'Проверка микрофона',
            onClose: () => Navigator.of(context).pop(),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Container(
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: colors.muted,
                    borderRadius: BorderRadius.circular(22),
                    border: Border.all(color: colors.border),
                  ),
                  child: Column(
                    children: [
                      Icon(
                        level > 0.02
                            ? Icons.graphic_eq_rounded
                            : Icons.mic_rounded,
                        size: 48,
                        color: level > 0.02
                            ? Colors.greenAccent.shade400
                            : Theme.of(context).colorScheme.primary,
                      ),
                      const SizedBox(height: 16),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(999),
                        child: LinearProgressIndicator(
                          value: level,
                          minHeight: 14,
                          backgroundColor: colors.border,
                          color: level > 0.7
                              ? Colors.orangeAccent
                              : Colors.greenAccent.shade400,
                        ),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        status,
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ],
                  ),
                ),
                if (_devices.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  Text(
                    'Устройство: ${_devices.first.label.isEmpty ? 'Системный микрофон' : _devices.first.label}',
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 16),
                  _InlineBanner(
                    icon: Icons.info_outline_rounded,
                    text: _error!,
                    destructive: false,
                  ),
                ],
                const SizedBox(height: 22),
                if (!voice.connected)
                  FilledButton.icon(
                    onPressed: _recording ? _stop : _start,
                    icon: Icon(
                      _recording
                          ? Icons.stop_rounded
                          : Icons.fiber_manual_record_rounded,
                    ),
                    label: Text(
                      _recording ? 'Остановить запись' : 'Записать фразу',
                    ),
                  ),
                if (!voice.connected && _recordingPath != null) ...[
                  const SizedBox(height: 10),
                  OutlinedButton.icon(
                    onPressed: _playing ? null : _play,
                    icon: Icon(
                      _playing
                          ? Icons.volume_up_rounded
                          : Icons.play_arrow_rounded,
                    ),
                    label: Text(
                      _playing ? 'Воспроизводится' : 'Прослушать запись',
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
