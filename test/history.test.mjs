import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// paths.ts reads VISUALLY_HOME at module load, so set it before importing.
process.env.VISUALLY_HOME = mkdtempSync(path.join(os.tmpdir(), 'vh-'));
const { latestVisualScore } = await import('../lib/history.js');
const { RUNS_DIR } = await import('../lib/paths.js');

test('latestVisualScore reads total from an improve run, null when absent', () => {
  assert.equal(latestVisualScore('thing'), null);

  const dir = path.join(RUNS_DIR, 'thing-20260101-000000');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'last-review.json'), JSON.stringify({ total: 87, verdict: 'in-progress' }));
  assert.equal(latestVisualScore('thing'), 87);
});
