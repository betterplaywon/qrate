-- CreateEnum
CREATE TYPE "TopUpStatus" AS ENUM ('pending', 'failed', 'paid');

-- CreateEnum
CREATE TYPE "PaymentProviderName" AS ENUM ('mock');

-- CreateEnum
CREATE TYPE "PaymentResult" AS ENUM ('paid', 'failed');

-- CreateEnum
CREATE TYPE "SettleOutcome" AS ENUM ('applied', 'stale');

-- CreateTable
CREATE TABLE "CreditTopUp" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "provider" "PaymentProviderName" NOT NULL,
    "status" "TopUpStatus" NOT NULL DEFAULT 'pending',
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditTopUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "provider" "PaymentProviderName" NOT NULL,
    "eventId" TEXT NOT NULL,
    "topUpId" TEXT NOT NULL,
    "result" "PaymentResult" NOT NULL,
    "outcome" "SettleOutcome" NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("provider","eventId")
);

-- CreateIndex
CREATE INDEX "CreditTopUp_tenantId_createdAt_idx" ON "CreditTopUp"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTopUp_tenantId_requestKey_key" ON "CreditTopUp"("tenantId", "requestKey");

-- AddForeignKey
ALTER TABLE "CreditTopUp" ADD CONSTRAINT "CreditTopUp_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_topUpId_fkey" FOREIGN KEY ("topUpId") REFERENCES "CreditTopUp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
