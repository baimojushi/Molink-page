'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWallPreferenceState, applyWallPreferenceState } = require('../../services/wallPreferencePublic');
const { buildSupplementDeliveryUpdate } = require('../../services/hangingSupplementResult');
const { normalizeThinkingPayload } = require('../../molink-miniapp-auction/utils/wallPreference');

function fakeDb(rows) {
  return {
    prepare() {
      return { all() { return rows; } };
    }
  };
}

test('delivered primary wall becomes current effect before user selection', () => {
  const order = {
    id: 'o1', status: 'delivered',
    delivery_images: JSON.stringify(['https://x/main.png']),
    delivery_result_records_json: JSON.stringify([{ wall_id: 'wall_main', final_image_url: 'https://x/main.png' }])
  };
  const state = buildWallPreferenceState(fakeDb([]), order);
  const thinking = applyWallPreferenceState({ candidates: [{ wall_id: 'wall_main' }, { wall_id: 'wall_b' }] }, state);
  assert.equal(thinking.current_effect_wall_id, 'wall_main');
  assert.equal(thinking.has_user_selection, false);
  assert.equal(thinking.candidates[0].current_effect, true);

  const ui = normalizeThinkingPayload({ thinking }, [], [], { delivered: true });
  assert.equal(ui.candidates[0].status_label, '当前效果');
  assert.equal(ui.candidates[0].is_disabled, true);
});

test('pending and succeeded supplementary jobs are exposed per wall', () => {
  const rows = [
    { chosen_wall_id: 'wall_b', supplement_job_id: 'job_b', supplement_status: 'pending', wallpaper_opt_in: 0 },
    { chosen_wall_id: 'wall_c', supplement_job_id: 'job_c', supplement_status: 'succeeded', wallpaper_opt_in: 1 }
  ];
  const state = buildWallPreferenceState(fakeDb(rows), { id: 'o2', status: 'delivered', delivery_images: '[]', delivery_result_records_json: '[]' });
  const thinking = applyWallPreferenceState({ candidates: [{ wall_id: 'wall_b' }, { wall_id: 'wall_c' }] }, state);
  assert.equal(thinking.has_pending_supplement, true);
  assert.equal(thinking.candidates[0].supplement_status, 'pending');
  assert.equal(thinking.candidates[1].supplement_status, 'succeeded');
});

test('supplement result appends a second delivery without replacing original', () => {
  const order = {
    delivery_images: JSON.stringify(['https://x/main.png']),
    delivery_result_records_json: JSON.stringify([{ wall_id: 'wall_main', candidate_id: 'c1', final_image_url: 'https://x/main.png' }]),
    hanging_candidate_records_json: JSON.stringify([{ wall_id: 'wall_main', candidate_id: 'c1', final_image_url: 'https://x/main.png' }])
  };
  const update = buildSupplementDeliveryUpdate(order, [{
    wall_id: 'wall_b', candidate_id: 'c2', final_image_url: 'https://x/wall-b.png', styling_status: 'succeeded'
  }], 'wall_main', false);
  assert.deepEqual(update.deliveryImages, ['https://x/main.png', 'https://x/wall-b.png']);
  assert.equal(update.deliveryRecords.length, 2);
  assert.equal(update.candidateRecords.length, 2);
});
