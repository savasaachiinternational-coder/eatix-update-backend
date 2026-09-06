#!/usr/bin/env node
/**
 * Checksum guard for filter-preset-spec.json (see SYNC.md at repo root).
 * This spec must stay byte-identical with Ethics-app's copy at
 * Ethics-app/src/constants/filter-preset-spec.json. The checksum's only
 * job is to force a deliberate, reviewable step whenever the spec
 * changes: this script fails the build if the JSON was edited without
 * regenerating the checksum, which then shows up as an explicit diff in
 * code review (and as a reminder to make the matching edit in the other
 * repo).
 *
 * Usage:
 *   node scripts/verify-filter-spec.js          # verify (CI / pre-commit)
 *   node scripts/verify-filter-spec.js --write  # regenerate after an intentional change
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SPEC_PATH = path.join(__dirname, '..', 'src', 'shorts', 'filter-preset-spec.json');
const HASH_PATH = path.join(__dirname, '..', 'src', 'shorts', 'filter-preset-spec.sha256');

function hashOf(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const write = process.argv.includes('--write');
const actual = hashOf(SPEC_PATH);

if (write) {
  fs.writeFileSync(HASH_PATH, `${actual}\n`);
  console.log(`[filter-spec] wrote ${HASH_PATH}`);
  process.exit(0);
}

if (!fs.existsSync(HASH_PATH)) {
  console.error(
    '[filter-spec] missing filter-preset-spec.sha256 — run `npm run hash:filter-spec` after an intentional change.',
  );
  process.exit(1);
}

const expected = fs.readFileSync(HASH_PATH, 'utf8').trim();
if (actual !== expected) {
  console.error('[filter-spec] filter-preset-spec.json changed without regenerating its checksum.');
  console.error('  If intentional: run `npm run hash:filter-spec`, then make the SAME edit to');
  console.error('  Ethics-app/src/constants/filter-preset-spec.json before committing either (see SYNC.md).');
  process.exit(1);
}
console.log('[filter-spec] OK');
