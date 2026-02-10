// services/textToImage.js —— 文字渲染为图片服务（基于 sharp + SVG）
// 使用 sharp 内置的 SVG 渲染能力，无需 canvas 原生编译依赖
const sharp = require('sharp');

/**
 * 将文字内容渲染为图片并保存
 * @param {string} text - 要渲染的文字内容
 * @param {string} outputPath - 输出图片的完整路径
 * @param {Object} options - 渲染选项
 */
async function 文字渲染为图片(text, outputPath, options = {}) {
  const {
    宽度 = 800,
    内边距 = 40,
    字体大小 = 28,
    行高倍数 = 1.6,
    文字颜色 = '#3a2a1a',
    背景颜色 = '#faf6f0',
    字体 = 'sans-serif'
  } = options;

  const 行高 = Math.round(字体大小 * 行高倍数);
  const 可用宽度 = 宽度 - 内边距 * 2;
  // 估算每行字符数（中英文混排取经验值0.85倍字体宽度）
  const 每行约字数 = Math.floor(可用宽度 / (字体大小 * 0.85));

  // 按段落拆分，再按行宽折行
  const 段落列表 = text.split('\n');
  const 所有行 = [];

  for (const 段落 of 段落列表) {
    if (段落.trim() === '') {
      所有行.push('');
      continue;
    }
    let 剩余 = 段落;
    while (剩余.length > 0) {
      if (剩余.length <= 每行约字数) {
        所有行.push(剩余);
        break;
      }
      所有行.push(剩余.substring(0, 每行约字数));
      剩余 = 剩余.substring(每行约字数);
    }
  }

  const 高度 = Math.max(200, 所有行.length * 行高 + 内边距 * 2);

  // XML 转义
  function 转义(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const 文字SVG = 所有行.map((行, i) => {
    const y = 内边距 + (i + 1) * 行高;
    if (行 === '') return '';
    return `<text x="${内边距}" y="${y}" font-family="${字体}" font-size="${字体大小}" fill="${文字颜色}">${转义(行)}</text>`;
  }).join('\n    ');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${宽度}" height="${高度}">
    <rect width="100%" height="100%" fill="${背景颜色}"/>
    ${文字SVG}
  </svg>`;

  await sharp(Buffer.from(svg)).png().toFile(outputPath);
  return outputPath;
}

module.exports = { 文字渲染为图片 };
