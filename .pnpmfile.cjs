// pnpm 설치 훅. @prisma/client가 선언한 "선택적" peer(prisma CLI, typescript)를 해석 단계에서 떼어 낸다.
//
// 왜: 같은 패키지(apps/server)에 devDependency로 있는 prisma CLI가 그 peer로 묶이면 pnpm이 lockfile에 optionalDependencies로 적고,
// `pnpm deploy --prod`(apps/server/Dockerfile)가 CLI와 그 의존 트리(스튜디오·pglite·typescript 등 약 220MB)를 런타임 이미지에 담는다.
// 런타임에는 CLI가 필요 없다 — 클라이언트는 WASM 쿼리 컴파일러(@prisma/client/runtime)와 pg 드라이버 어댑터로 돈다.
// `prisma generate`는 devDependency prisma가 그대로 맡는다. 측정: 이 훅 전 901MB → 후는 PR 본문.
//
// pnpm.overrides의 "-"(의존성 제거)는 peerDependencies에는 적용되지 않아 쓸 수 없었다(2026-11-04 실측).
// lockfile의 pnpmfileChecksum이 이 파일과 맞아야 하므로 바꾸면 pnpm install로 lockfile을 갱신한다.
function readPackage(pkg) {
  if (pkg.name === '@prisma/client') {
    for (const peer of ['prisma', 'typescript']) {
      delete pkg.peerDependencies?.[peer];
      delete pkg.peerDependenciesMeta?.[peer];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
