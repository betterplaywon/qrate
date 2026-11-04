-- compose의 db가 볼륨을 처음 만들 때 한 번 실행된다(postgres 이미지의 docker-entrypoint-initdb.d).
-- 저장소 계약 테스트(apps/server/test/repo-postgres.test.ts)용 전용 DB. 개발 DB(qrate)와 분리해 테스트 대화가 콘솔에 섞이지 않게 한다.
-- 마이그레이션은 따로 적용한다: DATABASE_URL=postgresql://qrate:qrate@localhost:5432/qrate_test pnpm --filter @qrate/server db:deploy
CREATE DATABASE qrate_test;
