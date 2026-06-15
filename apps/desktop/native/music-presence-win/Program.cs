using System.Globalization;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using Windows.Media.Control;

Console.OutputEncoding = Encoding.UTF8;

try
{
    var manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
    if (args.Any(arg => string.Equals(arg, "--watch", StringComparison.OrdinalIgnoreCase)))
    {
        await WatchAsync(manager);
        return;
    }

    await WriteCurrentSessionAsync(manager, includeArtwork: true);
}
catch
{
    Console.WriteLine("null");
}

static async Task WatchAsync(GlobalSystemMediaTransportControlsSessionManager manager)
{
    using var writerLock = new SemaphoreSlim(1, 1);
    var currentSession = manager.GetCurrentSession();
    AttachSessionEvents(manager, currentSession, writerLock);

    manager.CurrentSessionChanged += (_, _) =>
    {
        currentSession = manager.GetCurrentSession();
        AttachSessionEvents(manager, currentSession, writerLock);
        _ = WriteCurrentSessionAsync(manager, includeArtwork: true, writerLock);
    };

    await WriteCurrentSessionAsync(manager, includeArtwork: true, writerLock);
    await Task.Delay(Timeout.InfiniteTimeSpan);
}

static void AttachSessionEvents(
    GlobalSystemMediaTransportControlsSessionManager manager,
    GlobalSystemMediaTransportControlsSession? session,
    SemaphoreSlim writerLock)
{
    if (session is null) return;

    session.PlaybackInfoChanged += (_, _) =>
        _ = WriteCurrentSessionAsync(manager, includeArtwork: true, writerLock);
    session.MediaPropertiesChanged += (_, _) =>
        _ = WriteCurrentSessionAsync(manager, includeArtwork: true, writerLock);
    session.TimelinePropertiesChanged += (_, _) =>
        _ = WriteCurrentSessionAsync(manager, includeArtwork: false, writerLock);
}

static async Task WriteCurrentSessionAsync(
    GlobalSystemMediaTransportControlsSessionManager manager,
    bool includeArtwork,
    SemaphoreSlim? writerLock = null)
{
    if (writerLock is not null) await writerLock.WaitAsync();

    try
    {
        var session = manager.GetCurrentSession();
        if (session is null || !IsAllowedMusicSource(session.SourceAppUserModelId))
        {
            Console.WriteLine("null");
            return;
        }

        var props = await session.TryGetMediaPropertiesAsync();
        var timeline = session.GetTimelineProperties();
        var playback = session.GetPlaybackInfo();
        var observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (playback.PlaybackStatus != GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
        {
            Console.WriteLine("null");
            return;
        }

        var artworkUrl = includeArtwork ? await ReadArtworkDataUrl(props) : null;

        var fields = new List<(string Key, object? Value)>
        {
            ("appUserModelId", session.SourceAppUserModelId),
            ("title", props.Title),
            ("artist", props.Artist),
            ("albumTitle", props.AlbumTitle),
            ("durationMs", (long)timeline.EndTime.TotalMilliseconds),
            ("positionMs", (long)timeline.Position.TotalMilliseconds),
            ("playbackStatus", playback.PlaybackStatus.ToString()),
            ("artworkUrl", artworkUrl),
            ("observedAt", observedAt),
        };

        Console.WriteLine(ToJsonObject(fields));
    }
    catch
    {
        Console.WriteLine("null");
    }
    finally
    {
        writerLock?.Release();
    }
}

static bool IsAllowedMusicSource(string appUserModelId)
{
    var appId = appUserModelId.ToLowerInvariant();
    if (appId.Contains("spotify", StringComparison.Ordinal)) return true;
    if (appId.Contains("apple", StringComparison.Ordinal) &&
        appId.Contains("music", StringComparison.Ordinal))
    {
        return true;
    }

    if (IsBrowserSource(appId)) return false;
    return appId.Contains("yandex", StringComparison.Ordinal) &&
        appId.Contains("music", StringComparison.Ordinal);
}

static bool IsBrowserSource(string appId)
{
    return appId.Contains("chrome", StringComparison.Ordinal) ||
        appId.Contains("msedge", StringComparison.Ordinal) ||
        appId.Contains("firefox", StringComparison.Ordinal) ||
        appId.Contains("brave", StringComparison.Ordinal) ||
        appId.Contains("opera", StringComparison.Ordinal) ||
        appId.Contains("yandexbrowser", StringComparison.Ordinal) ||
        appId.Contains("yandex.browser", StringComparison.Ordinal);
}

static async Task<string?> ReadArtworkDataUrl(GlobalSystemMediaTransportControlsSessionMediaProperties props)
{
    if (props.Thumbnail is null) return null;

    try
    {
        var randomAccessStream = await props.Thumbnail.OpenReadAsync();
        await using var netStream = randomAccessStream.AsStreamForRead();
        using var memory = new MemoryStream();
        netStream.CopyTo(memory);

        var bytes = memory.ToArray();
        if (bytes.Length == 0 || bytes.Length > 1_500_000) return null;

        var contentType = string.IsNullOrWhiteSpace(randomAccessStream.ContentType)
            ? "image/jpeg"
            : randomAccessStream.ContentType;

        return $"data:{contentType};base64,{Convert.ToBase64String(bytes)}";
    }
    catch
    {
        return null;
    }
}

static string ToJsonObject(IEnumerable<(string Key, object? Value)> fields)
{
    var builder = new StringBuilder();
    builder.Append('{');

    var first = true;
    foreach (var (key, value) in fields)
    {
        if (value is null) continue;
        if (!first) builder.Append(',');
        first = false;

        builder.Append('"').Append(EscapeJson(key)).Append("\":");
        switch (value)
        {
            case string text:
                builder.Append('"').Append(EscapeJson(text)).Append('"');
                break;
            case long number:
                builder.Append(number.ToString(CultureInfo.InvariantCulture));
                break;
            case int number:
                builder.Append(number.ToString(CultureInfo.InvariantCulture));
                break;
            default:
                builder.Append('"').Append(EscapeJson(Convert.ToString(value, CultureInfo.InvariantCulture) ?? "")).Append('"');
                break;
        }
    }

    builder.Append('}');
    return builder.ToString();
}

static string EscapeJson(string value)
{
    var builder = new StringBuilder(value.Length);
    foreach (var ch in value)
    {
        switch (ch)
        {
            case '"':
                builder.Append("\\\"");
                break;
            case '\\':
                builder.Append("\\\\");
                break;
            case '\b':
                builder.Append("\\b");
                break;
            case '\f':
                builder.Append("\\f");
                break;
            case '\n':
                builder.Append("\\n");
                break;
            case '\r':
                builder.Append("\\r");
                break;
            case '\t':
                builder.Append("\\t");
                break;
            default:
                if (char.IsControl(ch))
                {
                    builder.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                }
                else
                {
                    builder.Append(ch);
                }
                break;
        }
    }

    return builder.ToString();
}
