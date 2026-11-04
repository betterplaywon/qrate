import { z } from 'zod';

// 콘솔 문서의 CSP(default-src 'self')는 eval을 막는다. zod 4는 첫 스키마를 만들 때 `new Function`으로 빠른 파서를 쓸 수 있는지 시험하는데,
// 던진 오류는 삼키지만 브라우저는 CSP 위반으로 기록한다. 폼 검증은 느린 경로로 충분하므로 시험 자체를 끈다.
// main.tsx의 첫 import여야 한다 — 계약 스키마(@qrate/contracts/schemas)가 평가되기 전에 설정이 걸려야 하기 때문.
z.config({ jitless: true });
