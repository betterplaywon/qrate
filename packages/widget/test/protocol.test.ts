import { describe, expect, it } from 'vitest';
import { MAX_UNREAD, parseFrameMessage, parseLauncherMessage, toWire } from '../src/protocol';

// 런처 ↔ 대화창 postMessage 계약. 받는 쪽은 이름표(ns·v)·type·필드 타입을 전부 확인하고, 통과한 필드만 새 객체로 옮긴다.

describe('parseFrameMessage — 런처가 대화창에서 받는 것', () => {
  it('toWire로 만든 메시지는 그대로 돌아온다', () => {
    expect(parseFrameMessage(toWire({ type: 'ready' }))).toEqual({ type: 'ready' });
    expect(parseFrameMessage(toWire({ type: 'close' }))).toEqual({ type: 'close' });
    expect(parseFrameMessage(toWire({ type: 'unread', count: 3 }))).toEqual({ type: 'unread', count: 3 });
  });

  it('이름표가 없거나 다르면 null — 같은 페이지의 다른 iframe(광고 등)이 보낸 메시지', () => {
    expect(parseFrameMessage({ type: 'close' })).toBeNull();
    expect(parseFrameMessage({ ns: 'other', v: 1, type: 'close' })).toBeNull();
    expect(parseFrameMessage({ ns: 'qrate', v: 2, type: 'close' })).toBeNull();
    expect(parseFrameMessage('close')).toBeNull();
    expect(parseFrameMessage(null)).toBeNull();
    expect(parseFrameMessage([{ ns: 'qrate', v: 1, type: 'close' }])).toBeNull();
  });

  it('모르는 type과 틀린 필드 타입은 null', () => {
    expect(parseFrameMessage({ ns: 'qrate', v: 1, type: 'reload' })).toBeNull();
    expect(parseFrameMessage({ ns: 'qrate', v: 1, type: 'unread', count: '3' })).toBeNull();
    expect(parseFrameMessage({ ns: 'qrate', v: 1, type: 'unread', count: 1.5 })).toBeNull();
    expect(parseFrameMessage({ ns: 'qrate', v: 1, type: 'unread', count: -1 })).toBeNull();
    expect(parseFrameMessage({ ns: 'qrate', v: 1, type: 'unread', count: MAX_UNREAD + 1 })).toBeNull();
  });

  it('통과한 필드만 옮긴다 — 덤으로 실린 필드는 버린다', () => {
    const parsed = parseFrameMessage({ ns: 'qrate', v: 1, type: 'unread', count: 2, extra: 'x' });
    expect(parsed).toEqual({ type: 'unread', count: 2 });
  });
});

describe('parseLauncherMessage — 대화창이 런처에서 받는 것', () => {
  it('visibility만 받고 open은 boolean이어야 한다', () => {
    expect(parseLauncherMessage(toWire({ type: 'visibility', open: true }))).toEqual({ type: 'visibility', open: true });
    expect(parseLauncherMessage({ ns: 'qrate', v: 1, type: 'visibility', open: 'true' })).toBeNull();
    expect(parseLauncherMessage({ ns: 'qrate', v: 1, type: 'close' })).toBeNull();
    expect(parseLauncherMessage(undefined)).toBeNull();
  });
});
