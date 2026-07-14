import { describe, expect, it } from 'vitest';
import {
  selectVideoConfig,
  selectAudioConfig,
  VIDEO_CODEC_LADDER,
  AUDIO_CODEC_LADDER,
} from './encode-bridge';

/** A fake `isConfigSupported` that reports `supported` only for the given codec prefixes. */
function probeFor(supportedCodecs: string[]): {
  isConfigSupported(config: { codec: string }): Promise<{ supported: boolean }>;
} {
  return {
    isConfigSupported: async (config): Promise<{ supported: boolean }> => ({
      supported: supportedCodecs.some((c) => config.codec.startsWith(c)),
    }),
  };
}

describe('selectVideoConfig — codec ladder', () => {
  it('picks AV1 when the platform supports it (top of the ladder)', async () => {
    const cfg = await selectVideoConfig(probeFor(['av01', 'hvc1', 'avc1']));
    expect(cfg.label).toBe('av1');
    expect(cfg.codec).toBe(VIDEO_CODEC_LADDER[0].codec);
  });

  it('falls back to HEVC when AV1 is unsupported', async () => {
    const cfg = await selectVideoConfig(probeFor(['hvc1', 'avc1']));
    expect(cfg.label).toBe('hevc');
  });

  it('falls back to H.264 when only H.264 is supported', async () => {
    const cfg = await selectVideoConfig(probeFor(['avc1']));
    expect(cfg.label).toBe('h264');
  });

  it('throws when NO video codec is supported', async () => {
    await expect(selectVideoConfig(probeFor([]))).rejects.toThrow(/no supported video codec/);
  });

  it('carries requested geometry into the chosen config', async () => {
    const cfg = await selectVideoConfig(probeFor(['av01']), { width: 1280, height: 720, framerate: 60 });
    expect(cfg.width).toBe(1280);
    expect(cfg.height).toBe(720);
    expect(cfg.framerate).toBe(60);
  });
});

describe('selectAudioConfig — codec ladder', () => {
  it('prefers Opus when supported', async () => {
    const cfg = await selectAudioConfig(probeFor(['opus', 'mp4a']));
    expect(cfg.label).toBe('opus');
    expect(cfg.codec).toBe(AUDIO_CODEC_LADDER[0].codec);
  });

  it('falls back to AAC when Opus is unsupported', async () => {
    const cfg = await selectAudioConfig(probeFor(['mp4a']));
    expect(cfg.label).toBe('aac');
  });

  it('throws when NO audio codec is supported', async () => {
    await expect(selectAudioConfig(probeFor([]))).rejects.toThrow(/no supported audio codec/);
  });
});
