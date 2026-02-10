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
      service_type_label: order.service_type_label
    });
  }

  res.json({
    status: 'delivered',
    service_type_label: order.service_type_label,
    images: JSON.parse(order.delivery_images || '[]'),
    text: order.delivery_text || '',
    delivered_at: order.delivered_at
  });
});

module.exports = router;
