const DEFAULT_ENTRY_KEY = 'garden-orange'

const ENTRY_PRESETS = {
  'garden-orange': {
    key: 'garden-orange',
    service: 'hang_in_home',
    artworkNum: '38',
    artworkName: '《花园系列》',
    artworkAuthor: '施歌',
    artworkVariant: '橙色',
    heroImagePath: '/assets/qr-entry/garden-orange-hero.jpg',
    brandText: 'Mo:link',
    titleText: '施歌 · 花园系列',
    subtitleText: '橙色作品 / No. 38',
    bodyLines: [
      '上滑后将直接进入',
      '作品挂进家',
      '并自动选好当前作品'
    ],
    hintText: '上滑挂进自己家'
  }
}

function parseScene(scene = '') {
  const text = decodeURIComponent(String(scene || '').trim())
  if (!text) return {}

  return text.split('&').reduce((acc, pair) => {
    const [rawKey, rawValue] = pair.split('=')
    const key = String(rawKey || '').trim()
    const value = String(rawValue || '').trim()
    if (key) acc[key] = value
    return acc
  }, {})
}

function normalizeOptionMap(options = {}) {
  const sceneMap = options.scene ? parseScene(options.scene) : {}
  return Object.assign({}, sceneMap, options)
}

function normalizeBodyLines(value, fallback = []) {
  if (Array.isArray(value) && value.length) return value
  const text = String(value || '').trim()
  if (!text) return fallback
  return text.split('|').map(item => String(item || '').trim()).filter(Boolean)
}

function resolveEntryPreset(options = {}) {
  const merged = normalizeOptionMap(options)
  const entryKey = merged.entryKey || merged.entry || merged.preset || DEFAULT_ENTRY_KEY
  const preset = ENTRY_PRESETS[entryKey] || ENTRY_PRESETS[DEFAULT_ENTRY_KEY]

  return Object.assign({}, preset, {
    entryKey: preset.key,
    artworkNum: String(merged.artworkNum || merged.num || preset.artworkNum || ''),
    artworkName: merged.artworkName || merged.name || preset.artworkName,
    artworkAuthor: merged.artworkAuthor || merged.author || preset.artworkAuthor,
    artworkVariant: merged.artworkVariant || merged.variant || preset.artworkVariant,
    service: merged.service || preset.service,
    heroImagePath: merged.heroImagePath || merged.heroImage || preset.heroImagePath,
    brandText: merged.brandText || preset.brandText,
    titleText: merged.titleText || preset.titleText,
    subtitleText: merged.subtitleText || preset.subtitleText,
    bodyLines: normalizeBodyLines(merged.bodyLines || merged.lines, preset.bodyLines),
    hintText: merged.hintText || preset.hintText,
    lockArtwork: String(merged.lockArtwork || '') === '1' || merged.lockArtwork === 1
  })
}

module.exports = {
  DEFAULT_ENTRY_KEY,
  ENTRY_PRESETS,
  parseScene,
  resolveEntryPreset
}
