// @qrate/contracts — 서버(apps/server)·위젯(packages/widget)·콘솔(apps/console)이 함께 쓰는 API 계약.
//
// 이 패키지는 브라우저·Node 어디서나 도는 순수 TypeScript다(DOM·Node API 없음, 의존성 없음).
// 소비하는 쪽은 package.json exports의 `source` 조건으로 소스를 바로 읽고(typecheck·테스트·vite 번들),
// Node 런타임(빌드된 서버)만 dist를 읽는다. 그래서 `pnpm -r build`가 contracts를 먼저 빌드한다.

export { drainSSEBuffer, type SSEEvent } from './sse.js';
export {
  CHAT_PATH,
  CONVERSATION_ID_HEADER,
  FRAME_PATH,
  MAX_MESSAGE_CHARS,
  encodeChatEvent,
  parseApiErrorBody,
  parseChatEvent,
  type ApiErrorBody,
  type ApiErrorCode,
  type ChatRequestBody,
  type ChatStreamEvent,
  type Citation,
  type HandoffReason,
  type StopReason,
  type StreamErrorCode,
} from './chat.js';
export {
  CONSOLE_API_PATH,
  CONSOLE_LIST_LIMIT,
  CONSOLE_PATH,
  HANDOFF_STATUSES,
  isHandoffStatus,
  type ConsoleLoginBody,
  type ConsoleSessionResponse,
  type ConsoleTenant,
  type ConversationDetailResponse,
  type ConversationListResponse,
  type ConversationSummaryDto,
  type HandoffDto,
  type HandoffListResponse,
  type HandoffQueueItemDto,
  type HandoffSource,
  type HandoffStatus,
  type MessageDto,
  type UpdateHandoffBody,
} from './console.js';
