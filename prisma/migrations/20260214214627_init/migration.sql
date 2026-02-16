-- CreateEnum
CREATE TYPE "ProofStatus" AS ENUM ('UNSPENT', 'PENDING', 'SPENT');

-- CreateTable
CREATE TABLE "Wallet" (
    "id" SERIAL NOT NULL,
    "accessKey" TEXT NOT NULL,
    "name" TEXT,
    "mint" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'sat',
    "maxBalance" INTEGER,
    "maxSend" INTEGER,
    "maxPay" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proof" (
    "id" SERIAL NOT NULL,
    "walletId" INTEGER NOT NULL,
    "proofId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "secret" TEXT NOT NULL,
    "C" TEXT NOT NULL,
    "dleq" TEXT,
    "witness" TEXT,
    "status" "ProofStatus" NOT NULL DEFAULT 'UNSPENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Proof_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_accessKey_key" ON "Wallet"("accessKey");

-- CreateIndex
CREATE UNIQUE INDEX "Proof_secret_key" ON "Proof"("secret");

-- AddForeignKey
ALTER TABLE "Proof" ADD CONSTRAINT "Proof_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
