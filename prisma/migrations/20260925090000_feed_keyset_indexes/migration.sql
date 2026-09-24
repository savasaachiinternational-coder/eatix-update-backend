-- Feed keyset pagination + trending/nearby lists (additive; no data changes).
-- CreateIndex
CREATE INDEX IF NOT EXISTS "Short_status_visibility_createdAt_id_idx" ON "Short"("status", "visibility", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Short_status_visibility_viewCount_id_idx" ON "Short"("status", "visibility", "viewCount" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Short_userId_createdAt_idx" ON "Short"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Video_status_visibility_createdAt_id_idx" ON "Video"("status", "visibility", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Video_status_visibility_viewCount_id_idx" ON "Video"("status", "visibility", "viewCount" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Video_userId_createdAt_idx" ON "Video"("userId", "createdAt" DESC);
