-- No-logo upload credits (paid packs)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "noLogoCredits" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "NoLogoCreditPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packageKey" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "amountGbp" DOUBLE PRECISION NOT NULL,
    "stripePaymentIntentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NoLogoCreditPurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NoLogoCreditPurchase_stripePaymentIntentId_key"
  ON "NoLogoCreditPurchase"("stripePaymentIntentId");

CREATE INDEX IF NOT EXISTS "NoLogoCreditPurchase_userId_idx"
  ON "NoLogoCreditPurchase"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'NoLogoCreditPurchase_userId_fkey'
  ) THEN
    ALTER TABLE "NoLogoCreditPurchase"
      ADD CONSTRAINT "NoLogoCreditPurchase_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
