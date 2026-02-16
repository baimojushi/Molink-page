// routes/admin.js —— 目标机管理后台 API 路由
const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { adminUpload } = require('../middleware/upload');
const { 发送交付通知到用户邮箱 } = require('../services/email');
const { 文字渲染为图片 } = require('../services/textToImage');

// 持久化目录
const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DELIVERIES_DIR = path.join(PERSISTENT_ROOT, 'deliveries');

// ==========================================
// 管理端鉴权中间件
// ==========================================
function 验证管理权限(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: '无权限访问管理后台' });
  }
  next();
}

router.use(验证管理权限);

// ==========================================
// 获取订单列表
// GET /api/admin/orders?status=pending
// ==========================================
router.get('/orders', (req, res) => {
  const { status } = req.query;
  let orders;
  if (status) {
    orders = db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC').all(status);
  } else {
    orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  }
  res.json({ orders });
});

// ==========================================
// 获取单个订单详情（含图片路径）
// GET /api/admin/orders/:id
// ==========================================
router.get('/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }
  res.json({ order });
});

// ==========================================
// 交付订单：上传处理后的图片和文字
// POST /api/admin/deliver/:id
// ==========================================
router.post('/deliver/:id',
  adminUpload.array('images', 10),
  async (req, res) => {
    try {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
      if (!order) {
        return res.status(404).json({ error: '订单不存在' });
      }

      const deliveryImages = req.files.map(f => f.filename);
      const deliveryText = req.body.text || '';

      // 如果有文字，渲染为图片
      let textImageFilename = null;
      if (deliveryText.trim()) {
        textImageFilename = `text_${uuidv4()}.png`;
        const textImagePath = path.join(DELIVERIES_DIR, textImageFilename);
        await 文字渲染为图片(deliveryText, textImagePath);
        deliveryImages.push(textImageFilename);
      }

      // 更新订单状态
      db.prepare(`
        UPDATE orders
        SET status = 'delivered',
            delivery_images = ?,
            delivery_text = ?,
            delivered_at = datetime('now','localtime')
        WHERE id = ?
      `).run(
        JSON.stringify(deliveryImages),
        deliveryText,
        req.params.id
      );

      // 生成交付页面链接（使用 molink.art 域名）
      const deliveryUrl = `https://www.molink.art/d/${order.delivery_token}`;

      // 发送邮箱通知
      let emailSent = false;
      try {
        emailSent = await 发送交付通知到用户邮箱(order, deliveryUrl);
      } catch (e) {
        console.error('邮件发送失败:', e);
      }

      // 记录邮件发送结果
      db.prepare('UPDATE orders SET email_sent = ? WHERE id = ?').run(emailSent ? 1 : 0, req.params.id);

      res.json({
        success: true,
        emailSent,
        message: emailSent ? '交付成功，通知已发送' : '交付成功，邮件发送失败（请手动通知用户）',
        deliveryUrl
      });

    } catch (error) {
      console.error('❌ 交付处理失败:', error);
      res.status(500).json({ error: '交付处理异常' });
    }
  }
);

// ==========================================
// 删除订单：删除订单记录及相关图片文件
// DELETE /api/admin/orders/:id
// ==========================================
router.delete('/orders/:id', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }

    const fs = require('fs');
    const UPLOADS_DIR = path.join(PERSISTENT_ROOT, 'uploads');

    // 删除用户上传的图片
    const 待删除文件 = [];
    if (order.artwork_image) {
      待删除文件.push(path.join(UPLOADS_DIR, order.artwork_image));
    }
    if (order.space_image) {
      待删除文件.push(path.join(UPLOADS_DIR, order.space_image));
    }

    // 删除交付图片
    if (order.delivery_images) {
      try {
        const deliveryImgs = JSON.parse(order.delivery_images);
        deliveryImgs.forEach(img => {
          待删除文件.push(path.join(DELIVERIES_DIR, img));
        });
      } catch (e) {
        console.error('解析交付图片列表失败:', e);
      }
    }

    // 执行文件删除
    待删除文件.forEach(filePath => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log('已删除文件:', filePath);
        }
      } catch (e) {
        console.error('删除文件失败:', filePath, e);
      }
    });

    // 删除数据库记录
    db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);

    res.json({ success: true, message: '订单及相关文件已删除' });

  } catch (error) {
    console.error('❌ 删除订单失败:', error);
    res.status(500).json({ error: '删除订单异常' });
  }
});

module.exports = router;
