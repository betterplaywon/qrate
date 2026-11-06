import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // docs/는 글과 로컬 전용 도구(.git/info/exclude)가 있는 곳이라 lint 대상이 아니다 — 로컬 `pnpm lint`가 CI와 같은 결과를 내게.
    // .audit·.claude/worktrees는 에이전트의 로컬 작업물(설계 스케치, 서브에이전트 worktree)이라 git에 없다. 보지 않으면 커밋 전 lint가 남의 사본에서 막힌다.
    ignores: ['**/dist/**', '**/node_modules/**', '**/.auth/**', 'docs/**', '**/src/generated/**', '.pnpmfile.cjs', '.audit/**', '.claude/worktrees/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 선언을 쓰는 자리보다 위에 둔다 — 함수 호이스팅과 클로저의 뒤늦은 바인딩에 기대지 않는다(2026-11-04 리뷰 반영).
      // 서로 참조하는 함수는 모듈 수준 헬퍼로 빼거나 클래스 메서드로 만든다. 타입 참조는 순서와 무관하므로 제외.
      '@typescript-eslint/no-use-before-define': [
        'error',
        { functions: true, classes: true, variables: true, ignoreTypeReferences: true },
      ],
    },
  },
  {
    // 대화창과 콘솔은 같은 오리진이다. 대화창에 HTML 주입이 하나라도 생기면 그 스크립트가 콘솔 API를 세션 쿠키째 부를 수 있다.
    // 그래서 서버·모델·방문자 문자열을 HTML로 해석하는 API를 막는다(2026-11-06 보안 감사).
    files: ['packages/widget/src/**', 'apps/console/src/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc', 'createContextualFragment'].map((property) => ({
          property,
          message: '문자열을 HTML로 해석하는 API다. textContent(대화창은 view.ts의 el)나 JSX 텍스트로 넣는다.',
        })),
        { object: 'document', property: 'write', message: 'document.write는 HTML을 해석한다. DOM API로 노드를 만든다.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: '문자열을 HTML로 해석한다. JSX 텍스트로 넣는다.',
        },
      ],
    },
  },
);
