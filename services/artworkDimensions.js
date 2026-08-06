// services/artworkDimensions.js —— 作品物理尺寸解析
//
// 移植服务端 scripts/parse_artwork_dimensions.py 逻辑。
// 输入尺寸文本（如 "51.2×67.8cm"、"51x68 cm"、"512×678mm"、"0.51×0.68m"），
// 输出 { width_m, height_m }；无法解析返回 null（上层据此回退 MMW 链路）。

// 分隔符变体：× x X * · 以及全角；单位 cm / mm / m，缺省按 cm
// 分隔符变体：× x X * · 以及全角；单位 cm / mm / m，缺省按 cm
// 注意：字符类内不含 . ，避免 "51.2.67.8" 被误解析为有效分隔符
const DIM_PATTERN = /(\d+(?:\.\d+)?)\s*[×xX*·．]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)/;

function parseArtworkSizeToMeters(sizeText) {
  if (!sizeText) return null;
  const text = String(sizeText).trim();
  const m = DIM_PATTERN.exec(text);
  if (!m) return null;

  const wVal = parseFloat(m[1]);
  const hVal = parseFloat(m[2]);
  if (!Number.isFinite(wVal) || !Number.isFinite(hVal) || wVal <= 0 || hVal <= 0) return null;

  const unit = String(m[3] || '').trim().toLowerCase();
  let scale;
  if (unit === '' || unit === 'cm') scale = 0.01;
  else if (unit === 'mm') scale = 0.001;
  else if (unit === 'm') scale = 1.0;
  else return null;

  const width_m = +(wVal * scale).toFixed(6);
  const height_m = +(hVal * scale).toFixed(6);

  // 合理性兜底：成品画通常在 5cm ~ 5m 之间，超出视为解析噪声
  if (width_m < 0.05 || width_m > 5 || height_m < 0.05 || height_m > 5) return null;

  return { width_m, height_m };
}

module.exports = { parseArtworkSizeToMeters };
