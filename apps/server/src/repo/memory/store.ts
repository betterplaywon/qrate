import type { Conversation } from '../types.js';

// 메모리 구현의 상태. 대화와 핸드오프 저장소가 같은 객체를 본다(DB에서는 같은 테이블들).
// 프로세스가 재시작되면 비워진다(dev의 tsx watch가 파일 변경마다 재시작한다).

export class MemoryStore {
  readonly conversations = new Map<string, Conversation>();
}
