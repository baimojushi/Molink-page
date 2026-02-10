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
      const { service_type, receive_method, receive_target, extra_service } = req.body;

      // 参数验证
      if (!service_type || !服务类型映射[service_type]) {
        return res.status(400).json({ error: '无效的服务类型' });
      }
      if (!receive_method || !['email', 'sms'].includes(receive_method)) {
        return res.status(400).json({ error: '请选择接收方式（邮箱或短信）' });
      }
      if (!receive_target || receive_target.trim() === '') {
        return res.status(400).json({ error: '请填写接收地址' });
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
        INSERT INTO orders (id, service_type, service_type_label, receive_method, receive_target, extra_service, artwork_image, space_image, delivery_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        orderId,
        service_type,
        serviceLabel,
        receive_method,
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
        message: '提交成功！处理完成后将通过您选择的方式通知您。',
        orderId: orderId
      });

    } catch (error) {
      console.error('❌ 订单提交失败:', error);
      res.status(500).json({ error: '服务器处理异常，请稍后重试' });
    }
  }
);

module.exports = router;
