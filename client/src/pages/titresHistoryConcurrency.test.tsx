import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldApplyHistoryResponse } from './Titres';

test('shouldApplyHistoryResponse ignore une réponse obsolète ou incohérente', () => {
  assert.equal(
    shouldApplyHistoryResponse({
      requestId: 1,
      activeRequestId: 2,
      requestedTitreId: 10,
      responseTitreId: 10,
    }),
    false,
  );

  assert.equal(
    shouldApplyHistoryResponse({
      requestId: 3,
      activeRequestId: 3,
      requestedTitreId: 10,
      responseTitreId: 11,
    }),
    false,
  );

  assert.equal(
    shouldApplyHistoryResponse({
      requestId: 4,
      activeRequestId: 4,
      requestedTitreId: 10,
      responseTitreId: 10,
    }),
    true,
  );
});
