/*
  Warnings:

  - Made the column `tenantId` on table `Event` required. This step will fail if there are existing NULL values in that column.
  - Made the column `payload` on table `Event` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "Event_type_createdAt_idx";

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "ttftMs" INTEGER,
ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "payload" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Event_tenantId_type_createdAt_idx" ON "Event"("tenantId", "type", "createdAt");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
