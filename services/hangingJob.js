// services/hangingJob.js —— 由订单构建 worker 作业载荷
const { parseArtworkSizeToMeters } = require('./artworkDimensions');

const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'https://www.molink.art';

const DEFAULT_HANGING_RENDER_PROVIDER = 'apiyi_gpt_image2_vip';
const HANGING_RENDER_PROVIDER_ALIASES = new Map([
  ['apiyi', 'apiyi_gpt_image2_vip'],
  ['apiyi_gpt_image2_vip', 'apiyi_gpt_image2_vip'],
  ['gpt_image2_vip', 'apiyi_gpt_image2_vip'],
  ['gpt-image-2-vip', 'apiyi_gpt_image2_vip'],
  ['bfl', 'bfl'],
  ['mock', 'mock']
]);

function normalizeRenderProvider(value) {
  const raw = String(value || DEFAULT_HANGING_RENDER_PROVIDER).trim().toLowerCase();
  const normalized = HANGING_RENDER_PROVIDER_ALIASES.get(raw);
  if (normalized) return normalized;
  console.warn(`[hanging] unknown HANGING_RENDER_PROVIDER=${raw}, fallback to ${DEFAULT_HANGING_RENDER_PROVIDER}`);
  return DEFAULT_HANGING_RENDER_PROVIDER;
}

function toUrl(filename) {
  if (!filename) return null;
  return String(filename).startsWith('http') ? filename : `${SERVER_BASE_URL}/uploads/${filename}`;
}

function intEnv(name, fallback, { min = 1, max = 20 } = {}) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function buildJobFromOrder(order) {
  const dim = parseArtworkSizeToMeters(order.artwork_size);

  const renderProvider = normalizeRenderProvider(process.env.HANGING_RENDER_PROVIDER);
  const renderGlobalLimit = intEnv('HANGING_RENDER_GLOBAL_LIMIT', 3, { min: 1, max: 10 });
  const renderPerWallLimit = intEnv('HANGING_RENDER_PER_WALL_LIMIT', 1, { min: 1, max: 10 });

  return {
    job_id: order.hanging_job_id || `job_${order.id}`,
    order_id: order.id,
    job_kind: order.service_type === 'recommend_work' ? 'recommend_work_render' : 'hang_in_home',
    pipeline_version: 'hanging-main-v1',
    eta_features: {
      service_type: order.service_type || '',
      room_bytes: Number(order.space_image_bytes) || null,
      artwork_bytes: Number(order.artwork_image_bytes) || null,
      room_pixel_bucket: order.room_pixel_bucket || 'unknown',
      candidate_limit: renderGlobalLimit,
      render_provider: renderProvider,
      styling_requested: order.service_type !== 'recommend_space' && !!order.extra_service,
      soft_furnishing_requested: order.service_type !== 'recommend_space' && !!order.extra_service,
      wallpaper_requested: false
    },
    room_image_url: toUrl(order.space_image),
    artwork_image_url: toUrl(order.artwork_image),
    artwork: dim ? { physical_width_m: dim.width_m, physical_height_m: dim.height_m, has_frame: true } : null,
    // Phase 2: order-level switch for the single Stage B styling pass.
    // recommend_space never exposes this service; ignore stale/forged values.
    soft_furnishing_requested: order.service_type !== 'recommend_space' && !!order.extra_service,

    rules_overrides: {
      scene_profile: 'home',
      flux_export: {
        per_wall_bfl_limit: renderPerWallLimit,
        global_final_render_limit: renderGlobalLimit
      }
    },

    // Render provider is intentionally duplicated at top-level and nested
    // render.provider. Older GPU workers read render.provider; newer workers
    // also accept render_provider/hanging_provider for diagnostics and replay.
    render_provider: renderProvider,
    hanging_provider: renderProvider,

    render: {
      provider: renderProvider,
      render_provider: renderProvider,
      per_wall_limit: renderPerWallLimit,
      global_limit: renderGlobalLimit
    },

    r2_output_prefix: `orders/${order.id}/${order.hanging_job_id || `job_${order.id}`}`
  };
}

module.exports = { buildJobFromOrder, toUrl, normalizeRenderProvider };
