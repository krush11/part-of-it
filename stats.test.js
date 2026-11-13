const test = require('node:test');
const assert = require('node:assert');
const { mode } = require('./stats');

test('empty list is 0', () => assert.strictEqual(mode([]), 0));
test('single most common value', () => assert.strictEqual(mode([3, 4, 4, 5, 9]), 4));
test('tie picks the highest value', () => assert.strictEqual(mode([2, 2, 7, 7, 1]), 7));
test('all distinct picks the highest', () => assert.strictEqual(mode([1, 2, 3]), 3));
