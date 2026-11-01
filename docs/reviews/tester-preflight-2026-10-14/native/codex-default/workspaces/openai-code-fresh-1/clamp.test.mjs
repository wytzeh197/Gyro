import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './src/clamp.mjs';
test('lower bound', () => assert.equal(clamp(-1, 0, 10), 0));
test('upper bound', () => assert.equal(clamp(11, 0, 10), 10));
