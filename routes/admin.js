// routes/admin.js —— 目标机管理后台 API 路由
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { adminUpload, DELIVERIES_DIR } = require('../middleware/upload');
const { 发送交付通知到用户邮箱 } = require('../services/email');
const { 文字渲染为图片 } = require('../services/textToImage');
const { submitImageRequest, checkExecution, downloadFile } = require('../services/snaptoshine');
const { notifyCollector } = require('../services/wxNotify');

// uploads 目录（用于删除订单时清理用户上传图片）
const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(PERSISTENT_ROOT, 'uploads');

// ==========================================
// "已交付"状态集合
// delivered → 刚交付；viewed → 用户已查收；downloaded → 用户已下载
// 三种状态都属于"已完成交付"，重新交付必须允许全部三种
// ==========================================
const DELIVERED_STATUSES = ['delivered', 'viewed', 'downloaded'];

// ==========================================
// 管理端鉴权中间件
// ==========================================
function 验证管理权限(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  const adminSecret = process.env.ADMIN_SECRET || 'Lyqyrxw1pbxzyh';
  if (secret !== adminSecret) {
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
  // delivery_images 从 JSON 字符串解析为数组，方便前端直接使用
  orders = orders.map(o => {
    try { o.delivery_images = o.delivery_images ? JSON.parse(o.delivery_images) : []; } catch { o.delivery_images = []; }
    return o;
  });
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
  try { order.delivery_images = order.delivery_images ? JSON.parse(order.delivery_images) : []; } catch { order.delivery_images = []; }
  res.json({ order });
});

// ==========================================
// 小程序单图上传接口（工作人员端两步上传）
// POST /api/admin/delivery/upload
// ==========================================
router.post('/delivery/upload',
  adminUpload.single('file'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: '未收到图片文件' });
    }
    res.json({ success: true, filename: req.file.filename });
  }
);

// ==========================================
// 工具：删除旧交付图片文件（静默，不阻断流程）
// ==========================================
function 删除旧交付文件(imageList) {
  if (!Array.isArray(imageList)) return;
  imageList.forEach(filename => {
    if (!filename) return;
    const fullPath = path.join(DELIVERIES_DIR, filename);
    fs.unlink(fullPath, err => {
      if (err && err.code !== 'ENOENT') {
        console.warn('⚠️ 删除旧交付文件失败:', filename, err.message);
      }
    });
  });
}

// ==========================================
// 交付 / 重新交付订单
// POST /api/admin/deliver/:id
//
// 支持两种上传方式（可混用）：
//   1. 直接 multipart 上传：字段名 images（可多张）
//   2. 两步上传（小程序）：先调 /delivery/upload，再传 filenames JSON 数组
//
// body 字段：
//   images     - 直接上传的图片文件
//   filenames  - 两步上传已保存的文件名数组（JSON 字符串或数组）
//   text       - 可选文字，渲染为图片追加到交付列表
//   redeliver  - '1' 表示重新交付，覆盖旧内容；delivery_token 不变，不重发通知
// ==========================================
router.post('/deliver/:id',
  adminUpload.array('images', 20),
  async (req, res) => {
    try {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
      if (!order) {
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        return res.status(404).json({ error: '订单不存在' });
      }

      const isRedeliver = req.body.redeliver === '1';
      const alreadyDelivered = DELIVERED_STATUSES.includes(order.status);

      // 状态校验
      // 修复根因：旧版只判断 status === 'delivered'，导致 viewed / downloaded 状态的
      // 订单无法重新交付（报"订单尚未交付"），也无法被普通交付拦截（报400）。
      // 正确逻辑：delivered / viewed / downloaded 三者均视为"已交付"。
      if (!isRedeliver && alreadyDelivered) {
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ error: '订单已交付，如需更新请使用重新交付（redeliver=1）' });
      }
      if (isRedeliver && !alreadyDelivered) {
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ error: '订单尚未交付，请使用普通交付' });
      }

      // 收集交付图片文件名
      // 方式1：直接上传的文件
      const directFilenames = (req.files || []).map(f => f.filename);

      // 方式2：两步上传已保存的文件名
      let stepFilenames = [];
      const bodyFilenames = req.body.filenames;
      if (bodyFilenames) {
        stepFilenames = Array.isArray(bodyFilenames)
          ? bodyFilenames
          : JSON.parse(bodyFilenames);
      }

      let deliveryImages = [...directFilenames, ...stepFilenames];
      const deliveryText = (req.body.text || '').trim();

      // 至少需要图片或文字
      if (deliveryImages.length === 0 && !deliveryText) {
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ error: '请至少上传一张图片或输入文字' });
      }

      // 文字渲染为图片（可选）
      if (deliveryText) {
        const textImageFilename = `text_${uuidv4()}.png`;
        const textImagePath = path.join(DELIVERIES_DIR, textImageFilename);
        await 文字渲染为图片(deliveryText, textImagePath);
        deliveryImages.push(textImageFilename);
      }

      // 重新交付：先删除旧文件，delivery_token 不变
      if (isRedeliver) {
        try {
          const oldImages = JSON.parse(order.delivery_images || '[]');
          删除旧交付文件(oldImages);
        } catch (e) {
          console.warn('解析旧交付图片列表失败，跳过删除:', e.message);
        }
      }

      // 更新数据库
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

      const deliveryUrl = `https://www.molink.art/d/${order.delivery_token}`;

      // 发送通知（仅首次交付；重新交付不重复打扰用户）
      let emailSent = false;
      if (!isRedeliver) {
        try {
          emailSent = await 发送交付通知到用户邮箱(order, deliveryUrl);
        } catch (e) {
          console.error('邮件发送失败:', e);
        }
        db.prepare('UPDATE orders SET email_sent = ? WHERE id = ?').run(emailSent ? 1 : 0, req.params.id);
        // 微信订阅消息通知（有 openid 且用户已订阅时生效）
        notifyCollector(order.openid, order).catch(e => console.error('订阅消息通知失败:', e.message));
      }

      console.log(`✅ ${isRedeliver ? '重新' : ''}交付完成: ${req.params.id} -> ${deliveryUrl}`);

      res.json({
        success: true,
        emailSent,
        isRedeliver,
        message: isRedeliver
          ? '已覆盖交付内容，链接不变'
          : (emailSent ? '交付成功，通知已发送' : '交付成功，邮件发送失败（请手动通知用户）'),
        deliveryUrl
      });

    } catch (error) {
      console.error('❌ 交付处理失败:', error);
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      res.status(500).json({ error: '交付处理异常' });
    }
  }
);

// ==========================================
// 一键通过：把 AI 生成图设为交付结果并通知用户
// POST /api/admin/approve/:id
// body (可选): { selected_urls: ['url1', 'url2', ...] } — 指定交付哪几张；不传则交付全部通过的
// ==========================================
router.post('/approve/:id', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: '订单不存在' });

    // 获取所有通过审核的效果图 URL
    let resultUrls = [];
    try { resultUrls = JSON.parse(order.ai_result_urls || '[]'); } catch {}
    // 兼容旧数据：只有单张 ai_result_url 的订单
    if (resultUrls.length === 0 && order.ai_result_url) resultUrls = [order.ai_result_url];
    if (resultUrls.length === 0) return res.status(400).json({ error: 'AI 效果图尚未生成完成' });

    // 若管理员只选了部分图，按选择交付
    if (req.body.selected_urls && Array.isArray(req.body.selected_urls) && req.body.selected_urls.length > 0) {
      const filtered = req.body.selected_urls.filter(u => resultUrls.includes(u));
      if (filtered.length > 0) resultUrls = filtered;
    }

    // 下载所有选定图片并保存到 deliveries 目录
    const filenames = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const buf = await downloadFile(resultUrls[i]);
      const filename = `ai_${Date.now()}_${i}.jpg`;
      fs.writeFileSync(path.join(DELIVERIES_DIR, filename), buf);
      filenames.push(filename);
    }

    db.prepare(`
      UPDATE orders SET status='delivered', delivery_images=?, delivered_at=datetime('now','localtime') WHERE id=?
    `).run(JSON.stringify(filenames), order.id);

    const deliveryUrl = `https://www.molink.art/d/${order.delivery_token}`;
    let emailSent = false;
    try {
      emailSent = await 发送交付通知到用户邮箱(order, deliveryUrl);
      db.prepare('UPDATE orders SET email_sent=? WHERE id=?').run(emailSent ? 1 : 0, order.id);
    } catch (e) { console.error('邮件发送失败:', e); }
    notifyCollector(order.openid, order).catch(e => console.error('订阅消息通知失败:', e.message));

    console.log(`✅ AI 效果图已审核通过: ${order.id} 共 ${filenames.length} 张`);
    res.json({ success: true, emailSent, deliveryUrl, count: filenames.length });
  } catch (e) {
    console.error('approve 失败:', e);
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// 重新生成：用可选的调整说明重新提交 AI 任务
// POST /api/admin/regenerate/:id
// body: { note: '调整说明（可选）' }
// ==========================================
router.post('/regenerate/:id', async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (!order.ai_user_message) return res.status(400).json({ error: '该订单没有保存生图消息，无法重新生成' });

    let userMessage = JSON.parse(order.ai_user_message);

    // 如果管理员填写了备注，在消息末尾追加调整说明
    if (req.body.note && req.body.note.trim()) {
      userMessage = [...userMessage, { text: `\n\n调整要求：${req.body.note.trim()}` }];
    }

    const executionIds = await submitImageRequest({ userMessage });
    db.prepare('UPDATE orders SET ai_execution_id=?, ai_execution_ids=?, ai_result_url=NULL, ai_result_urls=NULL, ai_retry_count=0, status=? WHERE id=?')
      .run(executionIds[0], JSON.stringify(executionIds), 'ai_generating', order.id);

    console.log(`🔄 重新生成: 订单=${order.id} 批次=${executionIds.length} 个执行`);
    res.json({ success: true, executionId });
  } catch (e) {
    console.error('regenerate 失败:', e);
    res.status(500).json({ error: e.message });
  }
});

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
