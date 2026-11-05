// 임베더블 AI 상담 위젯의 런처 — 설치 스니펫 한 줄로 동작한다:
//   <script src="https://widget.example.com/widget.js" data-tenant="KEY" defer></script>
//   (data-endpoint는 위젯 서버가 스크립트와 다른 오리진일 때만 적는다. 로컬 데모가 그 경우다.)
//
// 구조(ADR-0003 하이브리드, 2026-11-02 결정):
//   - 런처(이 파일): 고객 사이트 문서 안의 Shadow DOM. 버튼과 패널 틀만 그린다. 호스트 CSS가 깨뜨리지 못하고, 서버를 직접 부르지 않는다.
//   - 대화창: 서버 오리진의 iframe(GET /frame?t=테넌트). 대화 내용과 API 호출은 전부 그 안에서 일어나 호스트 스크립트가 손댈 수 없다.
//     어느 사이트가 iframe으로 넣을 수 있는지는 서버가 /frame 응답의 CSP frame-ancestors로 정하고 브라우저가 강제한다.
//   - 둘 사이는 postMessage(src/protocol.ts)로 열림·닫힘·안 읽은 수와 서버가 배정한 인사말 변형만 주고받는다.
//   - 이 사이트의 localStorage에는 그 인사말 변형 id 하나만 둔다(키 qrate.greeting.<테넌트>). 다시 와도 같은 인사말을 보게.
// IIFE 번들(vite.config.ts) — 호스트의 빌드 설정과 무관하게 로드된다.

import { FRAME_PATH, VARIANT_ID_PATTERN } from '@qrate/contracts';
import { parseFrameMessage, toWire, type LauncherMessage } from './protocol';

interface LauncherConfig {
  /** 위젯 서버의 오리진. 대화창 iframe의 주소이자, postMessage를 보내고 받을 때 상대를 확인하는 기준이다. */
  serverOrigin: string;
  tenant: string;
}

const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
  .launcher {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
    width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
    background: #1f6feb; color: #fff; font-size: 22px; box-shadow: 0 4px 16px rgba(0,0,0,.25);
  }
  .badge {
    position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 6px;
    border-radius: 10px; background: #cf222e; color: #fff; font-size: 12px; font-weight: 600; line-height: 20px;
  }
  .badge[hidden] { display: none; }
  .panel {
    position: fixed; right: 20px; bottom: 84px; z-index: 2147483000;
    width: 360px; max-width: calc(100vw - 40px); height: 520px; max-height: calc(100vh - 104px);
    display: none; overflow: hidden;
    background: #fff; border: 1px solid #d0d7de; border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,.2);
  }
  .panel.open { display: block; }
  .frame { position: relative; z-index: 1; display: block; width: 100%; height: 100%; border: 0; }
  .loading { position: absolute; inset: 0; margin: 0; display: flex; align-items: center; justify-content: center;
    color: #57606a; font-size: 13px; }
`;

/**
 * 설정은 스크립트 평가 시점에 읽는다. document.currentScript는 그때만 유효하다 —
 * DOMContentLoaded 콜백 안에서 읽으면 null이라 설정이 조용히 사라진다. (docs/reviews.md 1번)
 * 테넌트 키가 없으면 설치하지 않는다. 기본값으로 엉뚱한 테넌트에 붙는 것보다 눈에 띄게 실패하는 쪽이 낫다.
 */
function readConfig(): LauncherConfig | null {
  const script = document.currentScript as HTMLScriptElement | null;
  const tenant = script?.dataset.tenant?.trim();
  if (!script || !tenant) {
    console.error('[qrate] data-tenant가 없어 위젯을 설치하지 않습니다.');
    return null;
  }
  // 기본은 스크립트를 내려준 오리진 — 위젯 서버가 widget.js와 대화창을 함께 서빙한다.
  const endpoint = script.dataset.endpoint?.trim() || script.src;
  try {
    return { serverOrigin: new URL(endpoint, location.href).origin, tenant };
  } catch {
    console.error(`[qrate] data-endpoint가 URL이 아닙니다: ${endpoint}`);
    return null;
  }
}

/** 같은 사이트에 테넌트가 둘이어도 섞이지 않게 테넌트로 나눈다. 실험 구분은 키가 아니라 값(변형 id 안의 실험 id)이 한다. */
const variantKey = (tenant: string): string => `qrate.greeting.${tenant}`;

/**
 * 지난 페이지 로드에 서버가 배정한 인사말 변형 id. 런처는 값의 뜻을 모르고, 맞는지는 서버가 판정한다.
 * 저장소가 막혔거나(사이트 데이터 차단 등에서 접근이 예외를 던진다) 형식이 틀리면(호스트 스크립트가 바꿀 수 있다) null.
 */
function storedVariant(tenant: string): string | null {
  try {
    const value = localStorage.getItem(variantKey(tenant));
    return value !== null && VARIANT_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** 마지막에 쓴 값이 이긴다. 탭 여럿이 동시에 첫 방문이어도 어느 값이든 서버가 배정한 유효한 값이다. */
function rememberVariant(tenant: string, variant: string): void {
  try {
    localStorage.setItem(variantKey(tenant), variant);
  } catch {
    // 막힌 저장소 — 다음 페이지 로드에 새로 배정된다.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function mount(config: LauncherConfig): void {
  const host = el('div');
  host.id = 'qrate-host';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLE;

  const launcher = el('button', 'launcher');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', '상담 열기');
  launcher.setAttribute('aria-expanded', 'false');
  const badge = el('span', 'badge');
  badge.hidden = true;
  launcher.append(el('span', undefined, '💬'), badge);

  const panel = el('div', 'panel');
  const loading = el('p', 'loading', '상담 창을 불러오는 중…');
  panel.append(loading);

  root.append(style, launcher, panel);
  document.body.appendChild(host);

  // 대화창 iframe은 처음 열 때 만든다. 열지 않은 방문자의 브라우저는 서버에 요청을 보내지 않는다.
  let frame: HTMLIFrameElement | null = null;
  let frameReady = false;
  let open = false;

  const createFrame = (): HTMLIFrameElement => {
    const f = el('iframe', 'frame');
    f.title = '상담 창';
    // o = 이 사이트의 오리진. 서버가 테넌트의 허용 목록과 대조한 뒤에야 대화창을 내려주고, 대화창은 그 값으로만 postMessage를 보낸다.
    const query = new URLSearchParams({ t: config.tenant, o: location.origin });
    // v = 지난 페이지 로드에 서버가 배정한 인사말 변형. 대화창은 해석하지 않고 서버에 그대로 넘긴다.
    const variant = storedVariant(config.tenant);
    if (variant) query.set('v', variant);
    f.src = `${config.serverOrigin}${FRAME_PATH}?${query}`;
    panel.append(f);
    return f;
  };

  // 대화창으로 보내는 메시지는 서버 오리진으로만. 다른 문서가 그 자리에 있으면(리다이렉트 등) 브라우저가 전달하지 않는다.
  const send = (msg: LauncherMessage): void => {
    if (frame && frameReady) frame.contentWindow?.postMessage(toWire(msg), config.serverOrigin);
  };

  const setUnread = (count: number): void => {
    badge.hidden = count === 0;
    badge.textContent = count > 9 ? '9+' : String(count);
    launcher.setAttribute('aria-label', count > 0 ? `상담 열기 — 새 답변 ${count}건` : '상담 열기');
  };

  const setOpen = (next: boolean): void => {
    open = next;
    panel.classList.toggle('open', open);
    launcher.setAttribute('aria-expanded', String(open));
    if (open) {
      setUnread(0);
      if (!frame) frame = createFrame();
      if (frameReady) frame.focus();
    } else {
      launcher.setAttribute('aria-label', '상담 열기');
    }
    send({ type: 'visibility', open });
  };

  // 받는 쪽은 세 가지를 모두 확인한다(src/protocol.ts): 보낸 문서의 오리진, 보낸 창, 메시지의 이름표와 형식.
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.origin !== config.serverOrigin) return;
    if (!frame || event.source !== frame.contentWindow) return;
    const msg = parseFrameMessage(event.data);
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        // 대화창 앱이 떴다. 이제부터 보낸 메시지를 받을 리스너가 있다.
        frameReady = true;
        loading.remove();
        send({ type: 'visibility', open });
        if (open) frame.focus();
        break;
      case 'close':
        setOpen(false);
        launcher.focus();
        break;
      case 'unread':
        if (!open) setUnread(msg.count);
        break;
      case 'greeting':
        rememberVariant(config.tenant, msg.variant);
        break;
    }
  });

  launcher.addEventListener('click', () => setOpen(!open));
}

const CONFIG = readConfig();

if (CONFIG) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mount(CONFIG));
  } else {
    mount(CONFIG);
  }
}
