import { describe, expect, it, vi } from 'vitest';
import { startPublish, type PublishFn } from './publish-session';

// The encode-bridge's encodeVideoTrack/encodeAudioTrack use WebCodecs
// (MediaStreamTrackProcessor/VideoEncoder) which aren't in the test env, so we
// mock them out — this suite asserts the ORCHESTRATION (codec selection →
// source assembly → publish() call), not the encoder internals.
vi.mock('./encode-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./encode-bridge')>();
  return {
    ...actual,
    encodeVideoTrack: vi.fn(() => new ReadableStream()),
    encodeAudioTrack: vi.fn(() => new ReadableStream()),
  };
});

function fakeTrack(kind: 'video' | 'audio'): MediaStreamTrack {
  return {
    kind,
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channelCount: 2 }),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function fakeStream(video: boolean, audio: boolean): MediaStream {
  const v = video ? [fakeTrack('video')] : [];
  const a = audio ? [fakeTrack('audio')] : [];
  return {
    getVideoTracks: () => v,
    getAudioTracks: () => a,
  } as unknown as MediaStream;
}

const supportAll = {
  isConfigSupported: async (): Promise<{ supported: boolean }> => ({ supported: true }),
};

/** First-call first-arg of a publish() mock, typed for assertions. */
function firstPublishArg(publish: PublishFn): {
  endpoint: string;
  key: string;
  source: { video?: unknown; audio?: unknown };
} {
  const calls = (publish as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const first = calls[0];
  if (!first) throw new Error('publish() was not called');
  return first[0] as { endpoint: string; key: string; source: { video?: unknown; audio?: unknown } };
}

describe('startPublish — chunk→publish plumbing', () => {
  it('calls publish() with endpoint + `key` (not bearer) and an encoded source', async () => {
    const stop = vi.fn(async () => {});
    const publish: PublishFn = vi.fn(async () => ({ stop }));
    const res = await startPublish(
      fakeStream(true, true),
      { endpoint: 'https://api.wave.online/v1/whip/publish', key: 'wif_short_lived' },
      { publish, videoProbe: supportAll, audioProbe: supportAll },
    );

    expect(publish).toHaveBeenCalledTimes(1);
    const arg = firstPublishArg(publish);
    expect(arg.endpoint).toBe('https://api.wave.online/v1/whip/publish');
    expect(arg.key).toBe('wif_short_lived');
    expect('bearer' in arg).toBe(false);
    expect(arg.source.video).toBeInstanceOf(ReadableStream);
    expect(arg.source.audio).toBeInstanceOf(ReadableStream);
    expect(res.videoCodec).toBe('av1');
    expect(res.audioCodec).toBe('opus');
  });

  it('publishes video-only when the stream has no audio track', async () => {
    const publish: PublishFn = vi.fn(async () => ({ stop: async () => {} }));
    const res = await startPublish(
      fakeStream(true, false),
      { endpoint: 'https://api.wave.online/v1/whip/publish', key: 'k' },
      { publish, videoProbe: supportAll, audioProbe: supportAll },
    );
    const arg = firstPublishArg(publish);
    expect(arg.source.video).toBeInstanceOf(ReadableStream);
    expect(arg.source.audio).toBeUndefined();
    expect(res.audioCodec).toBeNull();
  });

  it('throws when the stream has neither video nor audio', async () => {
    const publish: PublishFn = vi.fn(async () => ({ stop: async () => {} }));
    await expect(
      startPublish(
        fakeStream(false, false),
        { endpoint: 'https://api.wave.online/v1/whip/publish', key: 'k' },
        { publish, videoProbe: supportAll, audioProbe: supportAll },
      ),
    ).rejects.toThrow(/neither a video nor an audio track/);
    expect(publish).not.toHaveBeenCalled();
  });

  it('stop() tears down the publish session and the raw tracks', async () => {
    const sessionStop = vi.fn(async () => {});
    const publish: PublishFn = vi.fn(async () => ({ stop: sessionStop }));
    const stream = fakeStream(true, true);
    const videoTrack = stream.getVideoTracks()[0]!;
    const res = await startPublish(
      stream,
      { endpoint: 'https://api.wave.online/v1/whip/publish', key: 'k' },
      { publish, videoProbe: supportAll, audioProbe: supportAll },
    );
    await res.stop();
    expect(sessionStop).toHaveBeenCalledTimes(1);
    expect(videoTrack.stop).toHaveBeenCalledTimes(1);
  });
});
