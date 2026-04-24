import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

test('db.ts ne duplique pas la table recouvrement_actions déjà déclarée dans schema.sql', () => {
  const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');

  assert.equal(source.includes('const hasRecouvrementActions'), false);
  assert.equal(source.includes('CREATE TABLE recouvrement_actions'), false);
});
