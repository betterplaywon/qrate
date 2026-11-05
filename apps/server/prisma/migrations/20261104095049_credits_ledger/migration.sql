-- 크레딧 원장(W4 결정 2026-11-05): 멱등 키를 테넌트 범위로(전역 unique → (tenantId, idempotencyKey)), reason을 enum으로.
-- `prisma migrate diff --from-config-datasource --to-schema --script`로 만들었다(비대화형 환경에서 migrate dev가 경고 확인을 요구해서).
-- reason 열을 지웠다 다시 만드는 것은 표가 비어 있어서 문제없다(W1 이후 코드가 쓴 적 없음). 행이 있었다면 CAST로 옮겨야 했다.
-- CreateEnum
CREATE TYPE "CreditReason" AS ENUM ('seed', 'topup', 'turn', 'adjustment');

-- DropIndex
DROP INDEX "CreditLedger_idempotencyKey_key";

-- AlterTable
ALTER TABLE "CreditLedger" DROP COLUMN "reason",
ADD COLUMN     "reason" "CreditReason" NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_tenantId_idempotencyKey_key" ON "CreditLedger"("tenantId", "idempotencyKey");

