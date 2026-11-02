// 운영 콘솔(W3) — 지금은 정보 구조만 확정한 셸.
// 운영자가 데스크톱에서 대화 로그·미응답 큐를 오래 다루는 도구이므로
// 모바일 앱 내 탭이 아닌 "독립 웹 어드민"으로 만든다.

const SECTIONS = [
  { name: '대화 로그', desc: '테넌트별 대화 목록, 모더레이션 플래그 필터 (W3)' },
  { name: '미응답 큐', desc: 'AI가 답하지 못했거나 사람 연결이 요청된 대화 (W3)' },
  { name: '지식 관리', desc: 'FAQ·문서 업로드와 답변 출처 확인 (W2 연동)' },
  { name: '크레딧·이벤트', desc: '크레딧 잔액, A/B 변형별 이벤트 집계 (W4 연동)' },
] as const;

export function App() {
  return (
    <main style={{ maxWidth: 720, margin: '48px auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 22 }}>Qrate 운영 콘솔</h1>
      <p style={{ color: '#57606a' }}>
        W3에서 구현됩니다. 아래는 확정된 정보 구조입니다.
      </p>
      <ul style={{ lineHeight: 1.9 }}>
        {SECTIONS.map((s) => (
          <li key={s.name}>
            <strong>{s.name}</strong> — {s.desc}
          </li>
        ))}
      </ul>
    </main>
  );
}
