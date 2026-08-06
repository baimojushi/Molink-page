const test = require('node:test');
const assert = require('node:assert/strict');
const { digestOf, cleanItem } = require('../../services/evalDatasets');

test('dataset digest is stable across object key order', () => {
  assert.equal(digestOf({ b: 2, a: { d: 4, c: 3 } }), digestOf({ a: { c: 3, d: 4 }, b: 2 }));
});

test('dataset items require direct R2-compatible URLs and physical dimensions', () => {
  const item = cleanItem({
    id: 'room-1',
    room_image_url: 'https://r2/room.jpg',
    artwork_image_url: 'https://r2/art.png',
    artwork: { physical_width_m: '0.8', physical_height_m: 1.2 }
  }, 0);
  assert.equal(item.artwork.physical_width_m, 0.8);
  assert.throws(() => cleanItem({ room_image_url: 'r', artwork_image_url: 'a', artwork: {} }, 0), /physical/);
});
