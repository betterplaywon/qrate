import { describe, expect, it } from 'vitest';
import { drainSSEBuffer } from '../src/sse';

describe('drainSSEBuffer — 청크 경계 버퍼링', () => {
  it('완결된 이벤트만 파싱하고 미완결분은 rest로 남긴다', () => {
    const { events, rest } = drainSSEBuffer('data: {"delta":"안"}\n\ndata: {"del');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('{"delta":"안"}');
    expect(rest).toBe('data: {"del');
  });

  it('rest에 다음 청크를 이어 붙이면 이벤트가 완성된다', () => {
    const first = drainSSEBuffer('data: {"del');
    expect(first.events).toHaveLength(0);
    const second = drainSSEBuffer(first.rest + 'ta":"녕"}\n\n');
    expect(second.events[0]?.data).toBe('{"delta":"녕"}');
    expect(second.rest).toBe('');
  });

  it('event: 필드를 읽는다 (모더레이션 경고 이벤트)', () => {
    const { events } = drainSSEBuffer('event: moderation\ndata: {"level":"warn"}\n\n');
    expect(events[0]?.event).toBe('moderation');
    expect(events[0]?.data).toBe('{"level":"warn"}');
  });

  it('event가 없으면 기본값은 message', () => {
    const { events } = drainSSEBuffer('data: [DONE]\n\n');
    expect(events[0]?.event).toBe('message');
    expect(events[0]?.data).toBe('[DONE]');
  });

  it('한 버퍼에 이벤트 여러 개가 있어도 전부 파싱한다', () => {
    const { events } = drainSSEBuffer('data: {"delta":"a"}\n\ndata: {"delta":"b"}\n\n');
    expect(events).toHaveLength(2);
  });
});
