// routes/delivery.js —— 交付页面路由
const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../database');

// ==========================================
// 交付页面数据接口
// GET /d/:token
// ==========================================
router.get('/:token', (req, res) => {
  // 返回交付页面 HTML
  res.sendFile(path.join(__dirname, '..', 'public', 'delivery.html'));
});

// ==========================================
// 获取交付数据
// GET /d/:token/data
// ==========================================
router.get('/:token/data', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE delivery_token = ?').get(req.params.token);
  
  if (!order) {
    return res.status(404).json({ error: '页面不存在' });
  }

  if (order.status !== 'delivered') {
    return res.json({
      status: 'pending',
      message: '您的服务正在处理中，完成后将通知您。',
      service_type_label: order.service_type_label,
      device_uuid: order.device_uuid
    });
  }

  res.json({
    status: 'delivered',
    service_type_label: order.service_type_label,
    images: JSON.parse(order.delivery_images || '[]'),
    text: order.delivery_text || '',
    delivered_at: order.delivered_at,
    device_uuid: order.device_uuid
  });
});

// ==========================================
// 获取设备的所有已交付记录（用于 delivery 页展示历史）
// GET /d/:token/device-history
// ==========================================
router.get('/:token/device-history', (req, res) => {
  // 先找到这个 token 对应的订单，获取其 device_uuid
  const order = db.prepare('SELECT device_uuid FROM orders WHERE delivery_token = ?').get(req.params.token);
  
  if (!order || !order.device_uuid) {
    return res.json({ orders: [] });
  }

  const orders = db.prepare(`
    SELECT id, service_type_label, status, delivery_token, delivery_images, delivery_text, delivered_at, created_at
    FROM orders
    WHERE device_uuid = ? AND status = 'delivered'
    ORDER BY delivered_at DESC
  `).all(order.device_uuid);

  res.json({ orders });
});

module.exports = router;
