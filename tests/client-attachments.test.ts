import { describe, expect, it } from 'vitest';
import {
  prepareChatImageForUpload,
  shouldOptimizeChatImage,
} from '../src/lib/client-attachments';

describe('chat image optimization', () => {
  it('1MB以下の画像は再圧縮しない', async () => {
    const file = new File([new Uint8Array(1024)], 'small.png', {
      type: 'image/png',
    });

    expect(shouldOptimizeChatImage(file)).toBe(false);
    expect(await prepareChatImageForUpload(file)).toBe(file);
  });

  it('アニメーションを壊さないよう大きなGIFも再圧縮しない', async () => {
    const file = new File(
      [new Uint8Array(1024 * 1024 + 1)],
      'animation.gif',
      { type: 'image/gif' }
    );

    expect(shouldOptimizeChatImage(file)).toBe(false);
    expect(await prepareChatImageForUpload(file)).toBe(file);
  });

  it('大きな静止画だけを圧縮対象にする', () => {
    const file = new File(
      [new Uint8Array(1024 * 1024 + 1)],
      'screenshot.png',
      { type: 'image/png' }
    );

    expect(shouldOptimizeChatImage(file)).toBe(true);
  });
});
