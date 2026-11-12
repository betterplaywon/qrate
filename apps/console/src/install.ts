import type { InstallStatusResponse } from '@qrate/contracts';

// 설치 안내와 시작하기 화면의 규칙과 글. 빌더별 단계는 각 빌더의 공식 도움말에서 확인한 메뉴 이름만 쓴다(2026-11-12 확인).
// 메뉴 이름은 빌더가 바꿀 수 있어서 단계마다 공식 도움말 링크를 함께 둔다.

/** 시작하기의 FAQ 단계가 끝났다고 보는 개수. 방문객이 자주 묻는 것부터 이만큼은 있어야 위젯이 쓸모 있다. */
export const MIN_FAQ_FOR_START = 5;

/**
 * 사람이 적은 홈페이지 주소를 서버가 받는 정규형 오리진(scheme://host[:port])으로 바꾼다.
 * 앞에 https://가 없으면 붙이고 경로·쿼리·끝 슬래시는 버린다. http(s)가 아니거나 주소로 읽을 수 없으면 null.
 */
export function toSiteOrigin(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    const web = url.protocol === 'https:' || url.protocol === 'http:';
    // 점 없는 이름(https://haram)은 대개 오타다. 개발용 localhost만 받는다.
    const host = url.hostname.includes('.') || url.hostname === 'localhost';
    return web && host && !url.hostname.includes('*') ? url.origin : null;
  } catch {
    return null;
  }
}

export interface SetupProgress {
  origins: boolean;
  faq: boolean;
  /** 설치 신호(대화창 열림)가 왔다. 한 줄 붙이기와 설치 확인 두 단계가 이것 하나로 끝난다. */
  verified: boolean;
  /** 네 단계 중 끝난 수. */
  doneCount: number;
  done: boolean;
}

export function setupProgress(install: InstallStatusResponse, faqCount: number): SetupProgress {
  const origins = install.allowedOrigins.length > 0;
  const faq = faqCount >= MIN_FAQ_FOR_START;
  const verified = install.lastOpenedAt !== null;
  return { origins, faq, verified, doneCount: [origins, faq, verified, verified].filter(Boolean).length, done: origins && faq && verified };
}

export interface BuilderGuide {
  id: 'cafe24' | 'imweb' | 'wordpress' | 'custom';
  name: string;
  steps: string[];
  notes: string[];
  links: { label: string; href: string }[];
}

export const BUILDER_GUIDES: readonly BuilderGuide[] = [
  {
    id: 'cafe24',
    name: '카페24',
    steps: [
      '카페24 쇼핑몰 관리자 화면에 로그인해요.',
      '쇼핑몰 설정 > 기본 설정 > 쇼핑몰 정보로 가서, 검색엔진 최적화(SEO) 맨 아래의 "고급 설정"을 열어요.',
      '"코드 직접입력"의 Body 영역 칸에 2번에서 복사한 줄을 붙여 넣고 저장해요.',
    ],
    notes: ['PC 쇼핑몰과 모바일 쇼핑몰을 따로 고르는 화면이 나오면 두 곳 모두에 넣어 주세요.'],
    links: [{ label: '카페24 서비스 가이드', href: 'https://serviceguide.cafe24.com/IN/ko_KR/SG.SO.html' }],
  },
  {
    id: 'imweb',
    name: '아임웹',
    steps: [
      '아임웹 관리자 화면에 로그인해요.',
      '왼쪽 메뉴의 설정 > SEO로 가서 "고급 설정"의 "공통 코드 삽입"을 열어요.',
      '"Footer Code" 칸에 2번에서 복사한 줄을 붙여 넣고 저장해요.',
    ],
    notes: ['직접 넣은 코드는 아임웹 기술지원 대상이 아니에요. 위젯이 안 보이면 이 화면의 4번 설치 확인을 먼저 봐 주세요.'],
    links: [{ label: '아임웹 도움말: 공통 코드 삽입', href: 'https://imweb.me/faq?mode=view&category=29&category2=38&idx=71387' }],
  },
  {
    id: 'wordpress',
    name: '워드프레스',
    steps: [
      '관리자 화면의 플러그인 메뉴에서 "WPCode"를 찾아 설치하고 활성화해요.',
      '왼쪽 메뉴의 Code Snippets > Header & Footer로 가요.',
      '"Footer" 칸에 2번에서 복사한 줄을 붙여 넣고, 오른쪽 위의 "Save Changes"를 눌러요.',
    ],
    notes: [
      'WordPress.com에서 만든 사이트는 유료 요금제(Personal 이상)에서만 플러그인을 설치할 수 있어요.',
      '저장했는데 위젯이 안 보이면 캐시 플러그인의 캐시를 비우고 새로고침해 보세요.',
    ],
    links: [
      { label: 'WPCode 문서: Header & Footer', href: 'https://wpcode.com/docs/using-the-global-header-footer-settings/' },
      { label: 'WordPress.com 플러그인 안내', href: 'https://wordpress.com/support/plugins/' },
    ],
  },
  {
    id: 'custom',
    name: '직접 만든 홈페이지',
    steps: ['개발자에게 아래 안내문을 보내 주세요. 모든 페이지의 </body> 바로 앞에 한 줄을 넣으면 끝나요.'],
    notes: [],
    links: [],
  },
];

/** 다른 빌더. 공식 도움말을 확인한 것만 링크한다. */
export const OTHER_BUILDER_LINKS = [
  { label: '윅스: 사이트에 맞춤 코드 넣기', href: 'https://support.wix.com/en/article/embedding-custom-code-on-your-site' },
  { label: '식스샵: 코드 삽입', href: 'https://help.sixshop.com/learn-sixshop/store-manager/add-ons/code-injection' },
];

/** "직접 만든 홈페이지"에서 개발자에게 보내는 안내문. 위젯이 대화창 iframe과 <style>을 쓰므로 사이트 CSP에 필요한 것을 적는다. */
export function developerNote({ snippet, scriptUrl, allowedOrigins }: { snippet: string; scriptUrl: string; allowedOrigins: string[] }): string {
  const widgetOrigin = new URL(scriptUrl).origin;
  return [
    '홈페이지에 상담 위젯을 달려고 합니다. 모든 페이지의 </body> 바로 앞에 아래 한 줄을 넣어 주세요.',
    '',
    snippet,
    '',
    `- 위젯은 등록한 주소에서만 열립니다: ${allowedOrigins.join(', ') || '(아직 없음)'}`,
    `- 사이트에 Content-Security-Policy가 있다면 script-src와 frame-src에 ${widgetOrigin}을 더해 주세요.`,
    "- 위젯 버튼은 <style> 요소로 모양을 그립니다. style-src에 'unsafe-inline'이 없으면 버튼 모양이 깨질 수 있어요.",
    '- 넣은 뒤 페이지 오른쪽 아래의 버튼을 눌러 대화창이 열리는지 확인해 주세요.',
  ].join('\n');
}
