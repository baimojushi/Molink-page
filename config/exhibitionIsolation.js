const LEGACY_EXHIBITION = Object.freeze({
  id: 'legacy-bac-2026',
  name: '萤火石 BAC 青年艺术家培养计划作品博览',
  slug: 'bac-2026',
  status: 'live',
  venue_name: '上海外滩艺术中心 185 空间',
  starts_at: '2026-04-15',
  ends_at: null
});

const EXHIBITION_STATUSES = Object.freeze(['draft', 'live', 'archived']);

module.exports = {
  LEGACY_EXHIBITION,
  EXHIBITION_STATUSES
};
