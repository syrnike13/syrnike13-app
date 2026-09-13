import {
  AudioFrame, AudioSource, LocalAudioTrack, LocalVideoTrack, TrackPublishOptions,
  TrackSource, VideoBufferType, VideoFrame, VideoSource,
} from '@livekit/rtc-node'

// One bounded synthetic camera/audio participant supplies real incoming media.
// This verifies transport/presentation, not physical camera or acoustic quality.
export async function startProductCompanion(room) {
  const videoSource = new VideoSource(320, 180)
  const audioSource = new AudioSource(48_000, 1, 100)
  const videoTrack = LocalVideoTrack.createVideoTrack('companion-camera', videoSource)
  const audioTrack = LocalAudioTrack.createAudioTrack('companion-audio', audioSource)
  let stopped = false
  let videoTimer
  let audioTask = Promise.resolve()
  const evidence = { videoFrames: 0, audioFrames: 0, failures: 0 }
  const stop = async () => {
    stopped = true
    clearInterval(videoTimer)
    audioSource.clearQueue()
    await audioTask
    await Promise.all([videoTrack.close(), audioTrack.close()])
  }
  try {
    await room.localParticipant.publishTrack(videoTrack, new TrackPublishOptions({
      source: TrackSource.SOURCE_CAMERA, simulcast: false,
    }))
    await room.localParticipant.publishTrack(audioTrack, new TrackPublishOptions({
      source: TrackSource.SOURCE_MICROPHONE,
    }))
    const pixels = new Uint8Array(320 * 180 * 3 / 2).fill(128)
    const video = new VideoFrame(pixels, 320, 180, VideoBufferType.I420)
    videoTimer = setInterval(() => {
      try {
        pixels.fill(32 + evidence.videoFrames % 192, 0, 320 * 180)
        videoSource.captureFrame(video, process.hrtime.bigint() / 1000n)
        ++evidence.videoFrames
      } catch { ++evidence.failures; clearInterval(videoTimer) }
    }, 33)
    const samples = new Int16Array(480)
    const audio = new AudioFrame(samples, 48_000, 1, 480)
    audioTask = (async () => {
      while (!stopped) {
        for (let index = 0; index < samples.length; ++index)
          samples[index] = Math.round(2_000 * Math.sin(2 * Math.PI * 440 * (evidence.audioFrames * 480 + index) / 48_000))
        // Await the SDK's capture acknowledgement before reusing this buffer.
        await audioSource.captureFrame(audio)
        ++evidence.audioFrames
      }
    })().catch(() => { if (!stopped) ++evidence.failures })
    return { evidence, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
