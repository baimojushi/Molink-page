// services/textToImage.js —— 文字渲染为图片服务
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

/**
 * 将文字内容渲染为图片并保存
 * @param {string} text - 要渲染的文字内容
 * @param {string} outputPath - 输出图片的完整路径
 * @param {Object} options - 渲染选项
 */
function 文字渲染为图片(text, outputPath, options = {}) {
  const {
    宽度 = 800,
    内边距 = 40,
    字体大小 = 28,
    行高倍数 = 1.6,
    文字颜色 = '#3a2a1a',
    背景颜色 = '#faf6f0',
    字体 = 'sans-serif'
  } = options;

  const 行高 = 字体大小 * 行高倍数;
  const 可用宽度 = 宽度 - 内边距 * 2;

  // 先计算文字需要的行数来确定画布高度
  const tempCanvas = createCanvas(宽度, 100);
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.font = `${字体大小}px ${字体}`;

  const 段落列表 = text.split('\n');
  let 总行数 = 0;

  for (const 段落 of 段落列表) {
    if (段落.trim() === '') {
      总行数 += 0.5; // 空行占半行高
      continue;
    }
    const 字符列表 = Array.from(段落);
    let 当前行宽 = 0;
    总行数 += 1;
    for (const 字符 of 字符列表) {
      const 字符宽度 = tempCtx.measureText(字符).width;
      if (当前行宽 + 字符宽度 > 可用宽度) {
        总行数 += 1;
        当前行宽 = 字符宽度;
      } else {
        当前行宽 += 字符宽度;
      }
    }
  }

  const 高度 = Math.ceil(总行数 * 行高 + 内边距 * 2);

  // 正式绘制
  const canvas = createCanvas(宽度, 高度);
  const ctx = canvas.getContext('2d');

  // 背景
  ctx.fillStyle = 背景颜色;
  ctx.fillRect(0, 0, 宽度, 高度);

  // 文字
  ctx.fillStyle = 文字颜色;
  ctx.font = `${字体大小}px ${字体}`;
  ctx.textBaseline = 'top';

  let y = 内边距;

  for (const 段落 of 段落列表) {
    if (段落.trim() === '') {
      y += 行高 * 0.5;
      continue;
    }
    const 字符列表 = Array.from(段落);
    let 当前行 = '';
    let 当前行宽 = 0;

    for (const 字符 of 字符列表) {
      const 字符宽度 = ctx.measureText(字符).width;
      if (当前行宽 + 字符宽度 > 可用宽度) {
        ctx.fillText(当前行, 内边距, y);
        y += 行高;
        当前行 = 字符;
        当前行宽 = 字符宽度;
      } else {
        当前行 += 字符;
        当前行宽 += 字符宽度;
      }
    }
    if (当前行) {
      ctx.fillText(当前行, 内边距, y);
      y += 行高;
    }
  }

  // 保存为 PNG
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

module.exports = { 文字渲染为图片 };
