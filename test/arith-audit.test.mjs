import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairArithmeticClaims } from '../lib/arith-audit.js';

test('repairs a wrong modular inverse (result first)', () => {
  // 1024^-1 mod 12289 = 12277, not 8857 (the exact bug that broke ntt-fpga refine)
  const { value, repairs } = repairArithmeticClaims({ n_inv: '8857 = 1024^-1 mod 12289' });
  assert.equal(value.n_inv, '12277 = 1024^-1 mod 12289');
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].claim, 'modular-inverse');
  assert.equal(repairs[0].path, 'n_inv');
});

test('repairs a wrong modular inverse (result last)', () => {
  const { value, repairs } = repairArithmeticClaims({ s: 'so 1024^-1 mod 12289 = 8857 here' });
  assert.equal(value.s, 'so 1024^-1 mod 12289 = 12277 here');
  assert.equal(repairs.length, 1);
});

test('leaves a correct modular inverse untouched', () => {
  const input = { s: '12277 = 1024^-1 mod 12289' };
  const { value, repairs } = repairArithmeticClaims(input);
  assert.equal(value.s, input.s);
  assert.equal(repairs.length, 0);
});

test('repairs a wrong modular power, leaves correct ones', () => {
  // 11^6 mod 12289 = 1945 (correct); 1945^2 mod 12289 = 10302 (correct)
  const ok = repairArithmeticClaims({ a: 'psi = 11^6 mod 12289 = 1945', b: 'omega = 1945^2 mod 12289 = 10302' });
  assert.equal(ok.repairs.length, 0);
  const bad = repairArithmeticClaims({ a: '11^6 mod 12289 = 1900' });
  assert.equal(bad.value.a, '11^6 mod 12289 = 1945');
  assert.equal(bad.repairs[0].claim, 'modular-power');
});

test('repairs a wrong floor division, leaves correct ones', () => {
  const ok = repairArithmeticClaims({ mu: 'floor(268435456 / 12289) = 21843' });
  assert.equal(ok.repairs.length, 0);
  const bad = repairArithmeticClaims({ mu: 'floor(268435456 / 12289) = 99999' });
  assert.equal(bad.value.mu, 'floor(268435456 / 12289) = 21843');
});

test('leaves symbolic claims untouched (no false repairs)', () => {
  const input = {
    a: 'N^-1 = 8857',            // symbolic base, no numeric operands
    b: 'floor(2^28 / q) = 21843', // symbolic operand q
    c: 'psi^{q-2} mod q',         // fully symbolic
  };
  const { value, repairs } = repairArithmeticClaims(input);
  assert.deepEqual(value, input);
  assert.equal(repairs.length, 0);
});

test('walks nested arrays and objects, does not mutate input', () => {
  const input = { parts: [{ id: 'x', spec: { notes: ['8857 = 1024^-1 mod 12289'] } }] };
  const { value, repairs } = repairArithmeticClaims(input);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].path, 'parts[0].spec.notes[0]');
  assert.equal(value.parts[0].spec.notes[0], '12277 = 1024^-1 mod 12289');
  // input untouched
  assert.equal(input.parts[0].spec.notes[0], '8857 = 1024^-1 mod 12289');
});

test('leaves non-invertible inverse claims untouched', () => {
  // gcd(6, 12) != 1 → no inverse; we must not invent one
  const input = { s: '5 = 6^-1 mod 12' };
  const { value, repairs } = repairArithmeticClaims(input);
  assert.equal(value.s, input.s);
  assert.equal(repairs.length, 0);
});
