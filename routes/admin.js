// routes/admin.js —— 目标机管理后台 API 路由
const express = require('express');
const router = express.Router();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { adminUpload } = require('../middleware/upload');
const { 发送交付通知到用户邮箱 } = require('../services/email');
const { 发送交付通知短信 } = require('../services/sms');
const { 文字渲染为图片 } = require('../services/textToImage');

// 持久化目录
const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DELIVERIES_DIR = path.join(PERSISTENT_ROOT, 'deliveries');

// ==========================================
// 管理端鉴权中间件
// 【验证请求头中的 x-admin-secret 是否匹配 .env 中的 ADMIN_SECRET】
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
  adminUpload.array('images', 10), // 最多10张交付图片
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

      // 生成交付页面链接
      const deliveryUrl = `${process.env.BASE_URL}/d/${order.delivery_token}`;

      // 根据用户选择的接收方式发送通知
      let notifySuccess = false;
      if (order.receive_method === 'email') {
        notifySuccess = await 发送交付通知到用户邮箱(order, deliveryUrl);
      } else if (order.receive_method === 'sms') {
        notifySuccess = await 发送交付通知短信(
          order.receive_target,
          deliveryUrl,
          order.service_type_label
        );
      }

      res.json({
        success: true,
        message: notifySuccess ? '交付成功，通知已发送' : '交付成功，通知发送失败（请手动联系用户）',
        deliveryUrl
      });

    } catch (error) {
      console.error('❌ 交付处理失败:', error);
      res.status(500).json({ error: '交付处理异常' });
    }
  }
);

module.exports = router;
