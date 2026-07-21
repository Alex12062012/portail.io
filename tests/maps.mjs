/**
 * maps.mjs — valide la jouabilité des 5 cartes de Tag Arena.
 *   node tests/maps.mjs
 */
import assert from 'node:assert';
import { MAPS } from '../shared/tag-map.js';
import { validateMap } from './map-validator.mjs';

assert.strictEqual(MAPS.length, 5, 'il doit y avoir 5 cartes');

const themes = new Set(MAPS.map(m => m.theme));
assert.strictEqual(themes.size, 5, 'les 5 thèmes doivent être distincts');

const ids = new Set(MAPS.map(m => m.id));
assert.strictEqual(ids.size, 5, 'les 5 ids doivent être distincts');

let total = 0;
for (const map of MAPS) {
  const errors = validateMap(map);
  if (errors.length) {
    console.error(`❌ ${map.id} (${map.name}) :\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`  ✔ ${map.id.padEnd(8)} ${map.name.padEnd(18)} ${map.width}×${map.height}, ${map.platforms.length} plateformes, ${map.pads.length} pads`);
  total++;
}
console.log(`✅ maps.mjs : ${total}/5 cartes valides et jouables`);
