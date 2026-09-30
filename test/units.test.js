import test from 'node:test';
import assert from 'node:assert/strict';
import { G_PER_OZ, showWeight, weightToGrams, showPrice, priceToPerGram, convertWeight, weightLabel, priceLabel } from '../public/units.js';

test('grams and ounces convert both ways', () => {
  assert.equal(showWeight(1000, 'oz'), 35.27);
  assert.equal(weightToGrams(35.27, 'oz'), 999.89);
  assert.equal(weightToGrams(1, 'oz'), 28.35);
  assert.equal(showWeight(720, 'g'), 720);
  assert.equal(weightToGrams('250', 'g'), 250);
});

test('blank stays blank, so an empty box never becomes 0', () => {
  for (const v of ['', null, undefined]) { assert.equal(showWeight(v, 'oz'), ''); assert.equal(weightToGrams(v, 'oz'), ''); assert.equal(priceToPerGram(v, 'oz'), ''); }
});

test('price per gram and per ounce convert both ways', () => {
  assert.equal(showPrice(0.022, 'oz'), 0.6237);
  assert.equal(showPrice(0.022, 'g'), 0.022);
  assert.equal(priceToPerGram(0.6237, 'oz'), 0.022);
  assert.equal(priceLabel(0.022, 'oz'), '$0.6237/oz');
  assert.equal(weightLabel(1000, 'oz'), '35.27 oz');
});

test('converter reports every unit', () => {
  assert.deepEqual(convertWeight(1, 'kg'), { g: 1000, oz: 35.27, lb: 2.205, kg: 1 });
  assert.equal(convertWeight(16, 'oz').lb, 1);
  assert.equal(convertWeight('', 'g'), null);
  assert.ok(Math.abs(G_PER_OZ - 28.3495) < 1e-4);
});
