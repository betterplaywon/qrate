import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp, type AppOptions } from '../../src/app.js';
import { MockEngine } from '../../src/engine/mock.js';
import { createRepositoriesFromSeed, loadSeedFile } from '../../src/repo/seed.js';
import type { Repositories } from '../../src/repo/types.js';

// 일부러 없는 폴더다. express.static은 폴더가 없어도 다음 라우트로 넘겨서 /frame/* 는 빈 폴더와 똑같이 404 JSON이 된다.
// 대화창 자산(app.js)을 보는 시험은 자기 폴더를 frameAssetsDir로 넘긴다.
const NO_FRAME_ASSETS = fileURLToPath(new URL('./no-frame-assets', import.meta.url));

export interface RunningApp {
  url: string;
  /** 앱이 쓰는 저장소. 넘기지 않았으면 데모 시드를 올린 메모리 저장소다. */
  repos: Repositories;
  close: () => Promise<void>;
}

/**
 * createApp을 임시 포트에 띄운다. 기본값은 HTTP 시험이 함께 쓰는 것만 둔다: 목업 엔진(지연 0), 데모 시드 메모리 저장소, 대화창 자산 없음.
 * publicOrigin은 시험 파일마다 달라서 받는다. 넘긴 옵션은 createApp에 그대로 간다.
 */
export async function startApp(options: Partial<AppOptions> & Pick<AppOptions, 'publicOrigin'>): Promise<RunningApp> {
  const repos = options.repos ?? createRepositoriesFromSeed(loadSeedFile());
  const app = createApp({ engine: new MockEngine(0), frameAssetsDir: NO_FRAME_ASSETS, ...options, repos });
  // 시험이 부르는 주소(127.0.0.1)에만 연다. 모든 주소로 열면 macOS에서 다른 프로세스가 127.0.0.1로 잡은 같은 포트와 겹쳐도 열리고,
  // 그러면 시험 요청이 그 프로세스로 갈 수 있다(가끔 뜻밖의 404가 난 원인으로 보는 가설, 실측은 못 함).
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve(s)));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    repos,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
