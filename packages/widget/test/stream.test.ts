import { encodeChatEvent, type ChatStreamEvent } from '@qrate/contracts';
import { describe, expect, it } from 'vitest';
import { parseRetryAfter, streamChat, type ChatEvent } from '../src/frame/stream';

// 대화 API 호출 한 번이 어떤 사건(ChatEvent)의 흐름이 되는지 고정한다. fetch를 가짜로 바꿔 서버 없이 돌린다.

function sseResponse(events: ChatStreamEvent[], init: { chunkSize?: number; headers?: Record<string, string> } = {}): Response {
  const text = events.map(encodeChatEvent).join('');
  const chunkSize = init.chunkSize ?? text.length;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // 네트워크 청크가 이벤트 경계와 무관하게 끊기는 상황을 흉내 낸다.
      for (let i = 0; i < text.length; i += chunkSize) controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...init.headers } });
}

async function collect(res: Response | Error): Promise<{ events: ChatEvent[]; calls: { url: string; body: string }[] }> {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body) });
    if (res instanceof Error) throw res;
    return res;
  };
  const events: ChatEvent[] = [];
  for await (const ev of streamChat({ message: '환불', tenant: 'demo', conversationId: null }, { fetchImpl })) events.push(ev);
  return { events, calls };
}

const citation = { sourceIndex: 0, sourceId: 'faq:refund', title: '환불 정책', citedText: '7일 이내 전액 환불', blockStart: 0, blockEnd: 1 };

describe('streamChat — 정상 스트림', () => {
  it('상대 경로 /api/chat에 계약 본문으로 POST하고, 헤더의 대화 id → 조각 → 인용 → end(stopReason) 순으로 낸다', async () => {
    const { events, calls } = await collect(
      sseResponse(
        [
          { type: 'delta', text: '안' },
          { type: 'delta', text: '녕' },
          { type: 'citation', citation },
          { type: 'done', stopReason: 'end_turn', refusalCategory: null },
          { type: 'end' },
        ],
        { chunkSize: 7, headers: { 'X-Conversation-Id': 'conv-1' } },
      ),
    );
    expect(calls[0]?.url).toBe('/api/chat');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ message: '환불', tenant: 'demo', conversationId: null });
    expect(events).toEqual([
      { type: 'conversation', id: 'conv-1' },
      { type: 'delta', text: '안' },
      { type: 'delta', text: '녕' },
      { type: 'citation', citation },
      { type: 'end', stopReason: 'end_turn' },
    ]);
  });

  it('경고 레벨은 moderation 사건으로, 모르는 이벤트는 건너뛴다', async () => {
    const res = new Response('event: moderation\ndata: {"level":"warn","reasons":["r"]}\n\nevent: typing\ndata: {}\n\ndata: [DONE]\n\n');
    const { events } = await collect(res);
    expect(events).toEqual([{ type: 'moderation' }, { type: 'end', stopReason: null }]);
  });

  it('핸드오프 신호는 handoff 사건으로 — reason과 summary를 그대로, 답 조각과 end 사이에', async () => {
    const { events } = await collect(
      sseResponse([
        { type: 'delta', text: '그 내용은 안내 자료에 없어요.' },
        { type: 'handoff', reason: 'not_in_knowledge', summary: '카카오톡 알림 문의' },
        { type: 'done', stopReason: 'end_turn', refusalCategory: null },
        { type: 'end' },
      ]),
    );
    expect(events).toEqual([
      { type: 'delta', text: '그 내용은 안내 자료에 없어요.' },
      { type: 'handoff', reason: 'not_in_knowledge', summary: '카카오톡 알림 문의' },
      { type: 'end', stopReason: 'end_turn' },
    ]);
  });
});

describe('streamChat — 실패 단계', () => {
  it('fetch 자체가 실패하면 connect, 재시도 가능', async () => {
    const { events } = await collect(new TypeError('Failed to fetch'));
    expect(events).toEqual([{ type: 'failed', stage: 'connect', status: null, retryable: true, retryAfterMs: null }]);
  });

  it('첫 조각 전 HTTP 오류는 response — 본문의 retryable과 Retry-After를 읽는다', async () => {
    const res = new Response(JSON.stringify({ error: 'rate_limited', retryable: true }), {
      status: 503,
      headers: { 'Retry-After': '2' },
    });
    const { events } = await collect(res);
    expect(events).toEqual([{ type: 'failed', stage: 'response', status: 503, retryable: true, retryAfterMs: 2000 }]);
  });

  it('본문이 계약의 오류 본문이 아니면(프록시 오류 페이지) 상태 코드로 짐작한다', async () => {
    const { events } = await collect(new Response('<html>502</html>', { status: 502 }));
    expect(events).toEqual([{ type: 'failed', stage: 'response', status: 502, retryable: false, retryAfterMs: null }]);
  });

  it('422는 blocked — 다시 보내도 같다', async () => {
    const { events } = await collect(new Response(JSON.stringify({ error: 'blocked_by_moderation', reasons: ['x'] }), { status: 422 }));
    expect(events).toEqual([{ type: 'blocked' }]);
  });

  it('스트림 도중 event: error는 stream 실패이고 그 뒤 이벤트는 없다', async () => {
    const { events } = await collect(
      sseResponse([
        { type: 'delta', text: '부분' },
        { type: 'error', code: 'upstream_unavailable', retryable: true },
      ]),
    );
    expect(events).toEqual([
      { type: 'delta', text: '부분' },
      { type: 'failed', stage: 'stream', status: null, retryable: true, retryAfterMs: null },
    ]);
  });

  it('[DONE] 없이 끝나면 끊긴 것으로 본다', async () => {
    const { events } = await collect(sseResponse([{ type: 'delta', text: '부분' }]));
    expect(events.at(-1)).toEqual({ type: 'failed', stage: 'stream', status: null, retryable: true, retryAfterMs: null });
  });
});

describe('parseRetryAfter', () => {
  it('초 단위 정수만 ms로, 상한 60초', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(' 5 ')).toBe(5000);
    expect(parseRetryAfter('3600')).toBe(60_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});
