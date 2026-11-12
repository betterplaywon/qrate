import { describe, expect, it } from 'vitest';
import { knowledgeChars, widgetSnippet } from '../src/console.js';

describe('widgetSnippet — 설치 스니펫 한 줄', () => {
  it('스크립트 주소와 회사 키를 속성에 넣고 defer로 붙인다', () => {
    expect(widgetSnippet({ scriptUrl: 'https://qrate.example/widget.js', tenantKey: 'reception' })).toBe(
      '<script src="https://qrate.example/widget.js" data-tenant="reception" defer></script>',
    );
  });

  it('속성 값의 따옴표·꺾쇠·앰퍼샌드는 엔티티로 바꿔 줄이 깨지거나 다른 태그가 끼지 않는다', () => {
    expect(widgetSnippet({ scriptUrl: 'https://q.example/widget.js?a=1&b=2', tenantKey: 'x" onload="alert(1)<b>' })).toBe(
      '<script src="https://q.example/widget.js?a=1&amp;b=2" data-tenant="x&quot; onload=&quot;alert(1)&lt;b>" defer></script>',
    );
  });
});

describe('knowledgeChars — FAQ 합계 상한이 세는 양', () => {
  it('제목과 문단을 코드 포인트로 센다(분류는 세지 않는다)', () => {
    expect(knowledgeChars({ title: '주차', blocks: ['2시간 무료', '😀😀'] })).toBe(2 + 6 + 2);
  });
});
