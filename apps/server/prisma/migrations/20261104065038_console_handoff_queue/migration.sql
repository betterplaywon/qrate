-- 콘솔(2026-11-04): 핸드오프를 미응답 큐의 항목으로 — 상태·출처·연락처·테넌트 비정규화, 테넌트에 콘솔 키 해시.
-- Prisma가 만든 초안은 필수 열(tenantId·updatedAt)을 기본값 없이 더해 기존 행이 있으면 실패했다(개발 DB에 2행).
-- 그래서 손으로 고쳤다: 열을 NULL 허용으로 더하고 → 기존 행을 대화에서 채운 뒤 → NOT NULL을 건다. 빈 DB에서도 같은 결과다.
-- CreateEnum
CREATE TYPE "HandoffSource" AS ENUM ('model', 'visitor');

-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('open', 'in_progress', 'done');

-- AlterTable
ALTER TABLE "Handoff" ADD COLUMN     "contact" TEXT,
ADD COLUMN     "source" "HandoffSource" NOT NULL DEFAULT 'model',
ADD COLUMN     "status" "HandoffStatus" NOT NULL DEFAULT 'open',
ADD COLUMN     "tenantId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- 기존 행 채우기: 테넌트는 대화의 것, updatedAt은 createdAt
UPDATE "Handoff" h SET "tenantId" = c."tenantId" FROM "Conversation" c WHERE h."conversationId" = c."id";
UPDATE "Handoff" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;

ALTER TABLE "Handoff" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "updatedAt" SET NOT NULL;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "consoleKeyHash" TEXT;

-- CreateIndex
CREATE INDEX "Handoff_tenantId_status_createdAt_idx" ON "Handoff"("tenantId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
