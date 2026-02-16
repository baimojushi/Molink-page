// routes/client.js —— 用户端 API 路由
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { clientUpload } = require('../middleware/upload');
const { 发送订单通知到目标机 } = require('../services/email');

// 服务类型中文映射
const 服务类型映射 = {
  'hang_in_home': '作品挂进家',
  'recommend_work': '根据空间推荐作品',
  'recommend_space': '根据作品推荐空间'
};

// ==========================================
// 提交服务请求
// POST /api/client/submit
// ==========================================
router.post('/submit',
  clientUpload.fields([
    { name: 'artwork', maxCount: 1 },
    { name: 'space', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const { service_type, receive_target, extra_service, device_uuid } = req.body;

      // 参数验证
      if (!service_type || !服务类型映射[service_type]) {
        return res.status(400).json({ error: '无效的服务类型' });
      }
      if (!receive_target || receive_target.trim() === '') {
        return res.status(400).json({ error: '请填写接收邮箱' });
      }

      // 根据服务类型验证图片上传
      const artworkFile = req.files['artwork'] ? req.files['artwork'][0] : null;
      const spaceFile = req.files['space'] ? req.files['space'][0] : null;

      if (service_type === 'hang_in_home' && (!artworkFile || !spaceFile)) {
        return res.status(400).json({ error: '「作品挂进家」需同时上传作品图和空间图' });
      }
      if (service_type === 'recommend_work' && !spaceFile) {
        return res.status(400).json({ error: '「根据空间推荐作品」需上传空间图' });
      }
      if (service_type === 'recommend_space' && !artworkFile) {
        return res.status(400).json({ error: '「根据作品推荐空间」需上传作品图' });
      }

      // 生成订单
      const orderId = uuidv4();
      const deliveryToken = uuidv4().replace(/-/g, '').substring(0, 16);
      const serviceLabel = 服务类型映射[service_type];

      const stmt = db.prepare(`
        INSERT INTO orders (id, device_uuid, service_type, service_type_label, receive_method, receive_target, extra_service, artwork_image, space_image, delivery_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        orderId,
        device_uuid || null,
        service_type,
        serviceLabel,
        'email',
        receive_target.trim(),
        extra_service === 'true' || extra_service === '1' ? 1 : 0,
        artworkFile ? artworkFile.filename : null,
        spaceFile ? spaceFile.filename : null,
        deliveryToken
      );

      // 获取刚插入的完整订单记录（含 created_at）
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

      // 异步发送邮件通知到目标机（不阻塞响应）
      发送订单通知到目标机(order).catch(err => console.error('通知发送异常:', err));

      res.json({
        success: true,
        message: '提交成功！处理完成后将通过邮箱通知您。',
        orderId: orderId,
        deliveryToken: deliveryToken
      });

    } catch (error) {
      console.error('❌ 订单提交失败:', error);
      res.status(500).json({ error: '服务器处理异常，请稍后重试' });
    }
  }
);

// ==========================================
// 查询设备最新进行中的订单状态
// GET /api/client/device-status/:uuid
// ==========================================
router.get('/device-status/:uuid', (req, res) => {
  const deviceUuid = req.params.uuid;
  if (!deviceUuid) {
    return res.status(400).json({ error: '缺少设备标识' });
  }

  // 查找该设备最新一笔未完成或已交付的订单（排除已被用户主动重置的）
  const order = db.prepare(`
    SELECT id, service_type, service_type_label, status, delivery_token, delivery_images, delivery_text, delivered_at, created_at
    FROM orders
    WHERE device_uuid = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(deviceUuid);

  if (!order) {
    return res.json({ hasActiveOrder: false });
  }

  // 如果最新订单状态是 pending 或 processing 或 delivered，返回它
  if (order.status === 'pending' || order.status === 'processing') {
    return res.json({
      hasActiveOrder: true,
      status: order.status,
      orderId: order.id,
      serviceTypeLabel: order.service_type_label,
      deliveryToken: order.delivery_token
    });
  }

  if (order.status === 'delivered') {
    return res.json({
      hasActiveOrder: true,
      status: 'delivered',
      orderId: order.id,
      serviceTypeLabel: order.service_type_label,
      deliveryToken: order.delivery_token,
      images: JSON.parse(order.delivery_images || '[]'),
      text: order.delivery_text || '',
      deliveredAt: order.delivered_at
    });
  }

  // 其他状态（如 cancelled 等）视为无活跃订单
  res.json({ hasActiveOrder: false });
});

// ==========================================
// 查询订单交付数据（用于 index 页面轮询）
// GET /api/client/order-status/:orderId
// ==========================================
router.get('/order-status/:orderId', (req, res) => {
  const order = db.prepare(`
    SELECT id, status, delivery_images, delivery_text, delivered_at, service_type_label
    FROM orders WHERE id = ?
  `).get(req.params.orderId);

  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (order.status === 'delivered') {
    return res.json({
      status: 'delivered',
      images: JSON.parse(order.delivery_images || '[]'),
      text: order.delivery_text || '',
      deliveredAt: order.delivered_at,
      serviceTypeLabel: order.service_type_label
    });
  }

  res.json({
    status: order.status,
    serviceTypeLabel: order.service_type_label
  });
});

// ==========================================
// 查询设备所有历史订单
// GET /api/client/device-orders/:uuid
// ==========================================
router.get('/device-orders/:uuid', (req, res) => {
  const deviceUuid = req.params.uuid;
  if (!deviceUuid) {
    return res.status(400).json({ error: '缺少设备标识' });
  }

  const orders = db.prepare(`
    SELECT id, service_type, service_type_label, status, delivery_token, delivery_images, delivery_text, delivered_at, created_at
    FROM orders
    WHERE device_uuid = ?
    ORDER BY created_at DESC
  `).all(deviceUuid);

  res.json({ orders });
});

// ==========================================
// 标记为已查收（用户在 index 页加载了交付图）
// POST /api/client/mark-viewed/:orderId
// ==========================================
router.post('/mark-viewed/:orderId', (req, res) => {
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  // 仅在 delivered 状态时更新为 viewed
  if (order.status === 'delivered') {
    db.prepare("UPDATE orders SET status = 'viewed', viewed_at = datetime('now','localtime') WHERE id = ?").run(req.params.orderId);
  }
  res.json({ success: true });
});

// ==========================================
// 标记为已下载（用户长按保存了图片）
// POST /api/client/mark-downloaded/:orderId
// ==========================================
router.post('/mark-downloaded/:orderId', (req, res) => {
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  // viewed 或 delivered 状态均可更新为 downloaded
  if (['delivered', 'viewed'].includes(order.status)) {
    db.prepare("UPDATE orders SET status = 'downloaded', downloaded_at = datetime('now','localtime') WHERE id = ?").run(req.params.orderId);
  }
  res.json({ success: true });
});

module.exports = router;
