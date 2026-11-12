import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type {
  ConfirmTopUpBody,
  ConsoleLoginBody,
  CreateTopUpBody,
  KnowledgeInput,
  SimulatePaymentBody,
  UpdateAllowedOriginsBody,
  UpdateHandoffBody,
} from '../src/index.js';
import {
  confirmTopUpSchema,
  consoleLoginSchema,
  createTopUpSchema,
  knowledgeInputSchema,
  simulatePaymentSchema,
  updateAllowedOriginsSchema,
  updateHandoffSchema,
} from '../src/schemas.js';

// 요청 본문은 인터페이스(보내는 쪽의 타입)와 zod 스키마(서버의 검증)로 두 번 적혀 있다. 한쪽만 바뀌면 typecheck가 여기서 막는다.
// 위젯 본문(ChatRequestBody·HandoffRequestBody·WidgetEventBody)은 묶지 않는다. 옛 위젯과 호환하려고 서버가 conversationId·variant를
// 일부러 느슨하게 받아(lenientText) 스키마의 출력이 인터페이스와 다르다.
describe('요청 본문 인터페이스 = 스키마의 출력 타입', () => {
  it('콘솔', () => {
    expectTypeOf<z.output<typeof consoleLoginSchema>>().toEqualTypeOf<ConsoleLoginBody>();
    expectTypeOf<z.output<typeof updateHandoffSchema>>().toEqualTypeOf<UpdateHandoffBody>();
    expectTypeOf<z.output<typeof knowledgeInputSchema>>().toEqualTypeOf<KnowledgeInput>();
    expectTypeOf<z.output<typeof updateAllowedOriginsSchema>>().toEqualTypeOf<UpdateAllowedOriginsBody>();
  });

  it('충전', () => {
    expectTypeOf<z.output<typeof createTopUpSchema>>().toEqualTypeOf<CreateTopUpBody>();
    expectTypeOf<z.output<typeof simulatePaymentSchema>>().toEqualTypeOf<SimulatePaymentBody>();
    expectTypeOf<z.output<typeof confirmTopUpSchema>>().toEqualTypeOf<ConfirmTopUpBody>();
  });
});
