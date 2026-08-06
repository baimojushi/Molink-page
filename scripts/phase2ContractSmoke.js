'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildJobFromOrder } = require('../services/hangingJob');
const { normalizeProgressMessage } = require('../services/hangingProgressCopy');
const { buildThinking, resolveUserSupplementRenders, validateWallpaperOptIn, buildSupplementRenderJobsFromOrder } = require('../services/hangingThinking');
const { sanitizeDeliveryResultRecords } = require('../services/deliveryResultPublic');
const { mergeSupplementResult, buildSupplementDeliveryUpdate } = require('../services/hangingSupplementResult');

const baseOrder = {
  id: 42,
  hanging_job_id: 'job_42',
  service_type: 'hang_in_home',
  space_image: 'room.jpg',
  artwork_image: 'art.png',
  artwork_size: '60x80cm',
  extra_service: 1
};

const requested = buildJobFromOrder(baseOrder);
assert.strictEqual(requested.soft_furnishing_requested, true);

const notRequested = buildJobFromOrder({ ...baseOrder, extra_service: 0 });
assert.strictEqual(notRequested.soft_furnishing_requested, false);

const recommendSpace = buildJobFromOrder({ ...baseOrder, service_type: 'recommend_space', extra_service: 1 });
assert.strictEqual(recommendSpace.soft_furnishing_requested, false);

const supplement = buildSupplementRenderJobsFromOrder({
  ...baseOrder,
  primary_wall_id: 'wall_main',
  hanging_result_zip_url: 'https://example.test/result.zip',
  hanging_candidate_records_json: JSON.stringify([{ wall_id: 'wall_b', candidate_id: 'candidate_b' }])
}, ['wall_b'])[0];
assert.strictEqual(supplement.soft_furnishing_requested, true);
assert.deepStrictEqual(supplement.target_wall_ids, ['wall_b']);
assert.strictEqual(supplement.wallpaper_recolor, null);
assert.strictEqual(supplement.wallpaper_recolor_requested, false);

const supplementRecommendSpace = buildSupplementRenderJobsFromOrder({
  ...baseOrder,
  primary_wall_id: 'wall_main',
  service_type: 'recommend_space',
  hanging_result_zip_url: 'https://example.test/result.zip',
  hanging_candidate_records_json: JSON.stringify([{ wall_id: 'wall_b', candidate_id: 'candidate_b' }])
}, ['wall_b'])[0];
assert.strictEqual(supplementRecommendSpace.soft_furnishing_requested, false);

const wallpaperThinking = buildThinking({
  hanging_status: 'succeeded',
  hanging_result_zip_url: 'https://example.test/result.zip',
  hanging_candidate_records_json: JSON.stringify([{
    wall_id: 'wall_light', candidate_id: 'candidate_light', score: 0.91,
    install: {
      wall_mean_luminance: 0.78,
      suggest_dark_wallpaper: true,
      suggested_wall_tone_rgb: [58, 62, 71]
    }
  }]),
  hanging_not_recommended_json: '[]'
});
assert.strictEqual(wallpaperThinking.candidates[0].suggest_dark_wallpaper, true);
assert.deepStrictEqual(wallpaperThinking.candidates[0].suggested_wall_tone_rgb, [58, 62, 71]);
assert.ok(wallpaperThinking.candidates[0].wallpaper_copy.includes('墙偏浅'));

assert.deepStrictEqual(resolveUserSupplementRenders(['wall_main', 'wall_b'], 'wall_main', {}), ['wall_b']);
assert.deepStrictEqual(resolveUserSupplementRenders(['wall_main'], 'wall_main', { wall_main: true }), ['wall_main']);

const validationCandidates = [
  { wall_id: 'wall_dark', suggest_dark_wallpaper: true, suggested_wall_tone_rgb: [58, 62, 71] },
  { wall_id: 'wall_plain', suggest_dark_wallpaper: false, suggested_wall_tone_rgb: null }
];
assert.throws(
  () => validateWallpaperOptIn({ wall_missing: true }, ['wall_dark'], validationCandidates),
  error => error.statusCode === 400 && error.message.includes('未知墙面')
);
assert.throws(
  () => validateWallpaperOptIn({ wall_dark: true }, ['wall_plain'], validationCandidates),
  error => error.statusCode === 400 && error.message.includes('未在本次选中列表内')
);
assert.throws(
  () => validateWallpaperOptIn({ wall_plain: true }, ['wall_plain'], validationCandidates),
  error => error.statusCode === 400 && error.message.includes('不满足深色墙纸建议条件')
);
const forgedToneIgnored = validateWallpaperOptIn(
  { wall_dark: { tone_rgb: [255, 0, 0] } },
  ['wall_dark'],
  validationCandidates
);
assert.deepStrictEqual(forgedToneIgnored.wallpaperToneByWall.wall_dark, [58, 62, 71]);

const primaryWallpaperJob = buildSupplementRenderJobsFromOrder({
  ...baseOrder,
  primary_wall_id: 'wall_main',
  hanging_result_zip_url: 'https://example.test/result.zip',
  hanging_candidate_records_json: JSON.stringify([{
    wall_id: 'wall_main', candidate_id: 'candidate_main', asset_id: 'wall_main__candidate_main',
    pre_styling_image_url: 'https://example.test/wall_main__candidate_main.png',
    install: { suggest_dark_wallpaper: true, suggested_wall_tone_rgb: [58, 62, 71] }
  }])
}, ['wall_main'], { wall_main: true })[0];
assert.strictEqual(primaryWallpaperJob.primary_wall_rerender, true);
assert.strictEqual(primaryWallpaperJob.wallpaper_recolor_requested, true);
assert.strictEqual(primaryWallpaperJob.soft_furnishing_requested, true);
assert.deepStrictEqual(primaryWallpaperJob.wallpaper_recolor.tone_rgb, [58, 62, 71]);
assert.strictEqual(primaryWallpaperJob.pre_styling_image_url, 'https://example.test/wall_main__candidate_main.png');

const missingPrimaryBaseJobs = buildSupplementRenderJobsFromOrder({
  ...baseOrder,
  primary_wall_id: 'wall_main',
  hanging_result_zip_url: 'https://example.test/result.zip',
  hanging_candidate_records_json: JSON.stringify([{
    wall_id: 'wall_main', candidate_id: 'candidate_main',
    install: { suggest_dark_wallpaper: true, suggested_wall_tone_rgb: [58, 62, 71] }
  }])
}, ['wall_main'], { wall_main: true });
assert.deepStrictEqual(missingPrimaryBaseJobs, []);

const twoWallpaperJobs = buildSupplementRenderJobsFromOrder({
  ...baseOrder,
  primary_wall_id: 'wall_main',
  hanging_result_zip_url: 'https://example.test/result.zip',
  hanging_candidate_records_json: JSON.stringify([
    { wall_id: 'wall_b', candidate_id: 'candidate_b', install: { suggest_dark_wallpaper: true, suggested_wall_tone_rgb: [20, 30, 40] } },
    { wall_id: 'wall_c', candidate_id: 'candidate_c', install: { suggest_dark_wallpaper: true, suggested_wall_tone_rgb: [50, 60, 70] } }
  ])
}, ['wall_b', 'wall_c'], { wall_b: true, wall_c: true });
assert.strictEqual(twoWallpaperJobs.length, 2);
assert.notStrictEqual(twoWallpaperJobs[0].job_id, twoWallpaperJobs[1].job_id);
assert.deepStrictEqual(twoWallpaperJobs.map(job => job.wallpaper_recolor.tone_rgb), [[20, 30, 40], [50, 60, 70]]);

const originalRecords = [{
  wall_id: 'wall_main', candidate_id: 'candidate_main', asset_id: 'wall_main__candidate_main',
  rank: 1, final_image_url: 'https://example.test/current-styled.png',
  pre_styling_image_url: 'https://example.test/main-stage-a.png', styling_status: 'succeeded'
}];
const rejectedPrimary = mergeSupplementResult({ delivery_result_records_json: JSON.stringify(originalRecords) }, [{
  wall_id: 'wall_main', candidate_id: 'candidate_main', asset_id: 'wall_main__candidate_main',
  final_image_url: 'https://example.test/fallback-stage-a.png', styling_status: 'qa_rejected_fallback_to_plain'
}], 'wall_main', true);
assert.strictEqual(rejectedPrimary[0].final_image_url, 'https://example.test/current-styled.png');

const successfulPrimary = mergeSupplementResult({ delivery_result_records_json: JSON.stringify(originalRecords) }, [{
  wall_id: 'wall_main', candidate_id: 'candidate_main', asset_id: 'wall_main__candidate_main',
  final_image_url: 'https://example.test/wallpaper-styled.png',
  pre_styling_image_url: 'https://example.test/reuploaded-stage-a.png', styling_status: 'succeeded'
}], 'wall_main', true);
assert.strictEqual(successfulPrimary[0].final_image_url, 'https://example.test/wallpaper-styled.png');
assert.strictEqual(successfulPrimary[0].pre_styling_image_url, 'https://example.test/main-stage-a.png');

const publicRecords = sanitizeDeliveryResultRecords([
    {
      filename: 'a.png', styling_status: 'succeeded', pre_styling_image_url: 'https://example.test/a-stage-a.png',
      styling_zone_source: 'sam_support_union', styling_qa: { passed: true, edit_mask_area_px: 100 }
    },
    {
      filename: 'b.png', styling_status: 'not_requested', pre_styling_image_url: 'https://example.test/b-stage-a.png',
      styling_zone_source: 'fallback_lower_region', styling_qa: { passed: true }
    }
]);
assert.strictEqual(publicRecords[0].pre_styling_image_url, 'https://example.test/a-stage-a.png');
assert.strictEqual('styling_zone_source' in publicRecords[0], false);
assert.strictEqual('styling_qa' in publicRecords[0], false);
assert.strictEqual('pre_styling_image_url' in publicRecords[1], false);

const stylingProgress = normalizeProgressMessage({ stage: 'styling', pct: 82 });
assert.strictEqual(stylingProgress.text, '正在优化空间风格与色彩…');
assert.strictEqual(stylingProgress.orderStatus, 'hanging_rendering');

const processorSource = fs.readFileSync(path.join(__dirname, '../services/hangingResultProcessor.js'), 'utf8');
assert.ok(
  processorSource.indexOf("payload.supplement === true") < processorSource.indexOf('DELIVERED_STATUSES.includes(order.status)'),
  'supplement result routing must run before delivered-order idempotency guard'
);
const appendUpdate = buildSupplementDeliveryUpdate({
  delivery_images: JSON.stringify(['https://example.test/current-styled.png']),
  delivery_result_records_json: JSON.stringify(originalRecords),
  hanging_candidate_records_json: JSON.stringify(originalRecords)
}, [{
  wall_id: 'wall_b', candidate_id: 'candidate_b', asset_id: 'wall_b__candidate_b',
  final_image_url: 'https://example.test/wall-b-styled.png', styling_status: 'succeeded'
}], 'wall_main', false);
assert.deepStrictEqual(appendUpdate.deliveryImages, [
  'https://example.test/current-styled.png',
  'https://example.test/wall-b-styled.png'
]);
assert.strictEqual(appendUpdate.deliveryRecords.length, 2);
assert.ok(
  processorSource.includes('delivery_images = ?') &&
  processorSource.includes('hanging_candidate_records_json = ?'),
  'supplement result must append delivery images and update public candidate records'
);

console.log('phase5 contract smoke passed');
