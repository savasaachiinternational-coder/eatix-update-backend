-- CreateTable
CREATE TABLE "FaceLoginDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "templateCipher" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaceLoginDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaceLoginAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "secretHash" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "directions" TEXT[],
    "step" INTEGER NOT NULL DEFAULT 0,
    "frames" INTEGER NOT NULL DEFAULT 0,
    "frameHashes" TEXT[],
    "samplesCipher" TEXT,
    "processing" BOOLEAN NOT NULL DEFAULT false,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaceLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FaceLoginDevice_userId_idx" ON "FaceLoginDevice"("userId");

-- CreateIndex
CREATE INDEX "FaceLoginAttempt_userId_createdAt_idx" ON "FaceLoginAttempt"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "FaceLoginAttempt_expiresAt_idx" ON "FaceLoginAttempt"("expiresAt");

-- AddForeignKey
ALTER TABLE "FaceLoginDevice" ADD CONSTRAINT "FaceLoginDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaceLoginAttempt" ADD CONSTRAINT "FaceLoginAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

