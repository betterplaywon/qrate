import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerState } from '../src/frame/composer';

// 입력창 잠금 규칙: 서버가 Retry-After로 기다리라고 하면 그 시간 동안 쓰지도 보내지도 못하고, 시간이 지나면 풀리며 앱이 초점을 돌려준다.

function composer(): { composer: Composer; rendered: ComposerState[]; unlocked: () => number } {
  const rendered: ComposerState[] = [];
  let unlocks = 0;
  const c = new Composer({
    render: (state) => void rendered.push(state),
    unlocked: () => void unlocks++,
  });
  return { composer: c, rendered, unlocked: () => unlocks };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Composer', () => {
  it('답을 받는 동안은 busy, 끝나면 ready', () => {
    const { composer: c, rendered } = composer();
    c.setBusy(true);
    expect(c.isBusy()).toBe(true);
    c.setBusy(false);
    expect(c.isBusy()).toBe(false);
    expect(rendered).toEqual(['busy', 'ready']);
  });

  it('턴이 끝나 busy가 풀려도 잠금은 남고, Retry-After가 지나면 풀리며 unlocked를 한 번 부른다', () => {
    const { composer: c, rendered, unlocked } = composer();
    c.setBusy(true);
    c.lockFor(3000);
    c.setBusy(false);
    expect(c.state).toBe('locked');
    expect(rendered).toEqual(['busy', 'locked', 'locked']);

    vi.advanceTimersByTime(2999);
    expect(c.state).toBe('locked');
    expect(unlocked()).toBe(0);

    vi.advanceTimersByTime(1);
    expect(c.state).toBe('ready');
    expect(rendered.at(-1)).toBe('ready');
    expect(unlocked()).toBe(1);
  });

  it('잠긴 동안에도 대화 요청이 진행 중인지는 따로 알 수 있다. 진행 중에 풀리면 busy로 돌아간다', () => {
    const { composer: c } = composer();
    c.lockFor(1000);
    c.setBusy(true);
    expect(c.state).toBe('locked');
    expect(c.isBusy()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(c.state).toBe('busy');
  });

  it('더 짧은 두 번째 잠금은 기한을 줄이지 않는다', () => {
    const { composer: c, unlocked } = composer();
    c.lockFor(5000);
    vi.advanceTimersByTime(1000);
    c.lockFor(2000);
    vi.advanceTimersByTime(3999);
    expect(c.state).toBe('locked');
    vi.advanceTimersByTime(1);
    expect(c.state).toBe('ready');
    expect(unlocked()).toBe(1);
  });

  it('더 긴 두 번째 잠금은 늦은 기한까지 늘린다. 앞 잠금의 기한에 풀리지 않는다', () => {
    const { composer: c, unlocked } = composer();
    c.lockFor(2000);
    vi.advanceTimersByTime(1000);
    c.lockFor(5000);
    vi.advanceTimersByTime(1000);
    expect(c.state).toBe('locked');
    expect(unlocked()).toBe(0);
    vi.advanceTimersByTime(4000);
    expect(c.state).toBe('ready');
    expect(unlocked()).toBe(1);
  });
});
