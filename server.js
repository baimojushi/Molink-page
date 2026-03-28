// server.js —— Mo:link Design 主服务器
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { 启动定时清理 } = require('./services/cleanup');
const { submitImageRequest, checkExecution, downloadFile } = require('./services/snaptoshine');
const { reviewPhysics, reviewDimensions, reviewArtworkConsistency } = require('./services/qwen');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 中间件配置
// ==========================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 持久化数据根目录（Railway 上挂载 Volume 到此路径）
const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(PERSISTENT_ROOT, 'uploads');
const DELIVERIES_DIR = path.join(PERSISTENT_ROOT, 'deliveries');

app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/deliveries', express.static(DELIVERIES_DIR));

// 确保上传和交付目录存在
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DELIVERIES_DIR, { recursive: true });

// ==========================================
// 路由挂载
// ==========================================
const clientRoutes = require('./routes/client');
const adminRoutes = require('./routes/admin');
const deliveryRoutes = require('./routes/delivery');

app.use('/api/client', clientRoutes);
app.use('/api/admin', adminRoutes);
app.use('/d', deliveryRoutes);

// 隐私政策页面
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// 用户协议页面
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// 用户端首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 管理后台页面（需要密钥访问）
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==========================================
// 启动服务器
// ==========================================
app.listen(PORT, () => {
  console.log(`✅ Mo:link Design 服务器已启动: http://localhost:${PORT}`);
  console.log(`📋 管理后台: http://localhost:${PORT}/admin`);
  
  // 启动图片清理任务（2天有效期）
  启动定时清理();

  // 启动 AI 生图结果轮询（每 30 秒检查一次）
  启动AI轮询();
});

// ==========================================
// AI 生图结果轮询（含 Qwen 自动审核）
// MAX_AI_RETRIES: 最大重试次数，超过后无论是否通过均交给工作人员
// ==========================================
function 启动AI轮询() {
  const db = require('./database');
  const MAX_AI_RETRIES = parseInt(process.env.MAX_AI_RETRIES || '3');

  // 运行两道 Qwen 审核：初审（物理法则）+ 终审（尺寸）
  async function runQwenReview(order, imageUrl) {
    // 第1步：物理合理性检查（Flash）
    db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run('第1步：物理合理性检查（Flash初审）', order.id);
    const physics = await reviewPhysics(imageUrl);
    if (!physics.pass) {
      db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run(`第1步未通过：${physics.reason || '画面物理不合理'}`, order.id);
      return { pass: false };
    }

    // 第2步：画作一致性检查（Flash）——效果图里的画是否就是用户的那幅
    const artworkImageUrl = order.artwork_image
      ? (order.artwork_image.startsWith('http') ? order.artwork_image : `https://www.molink.art/uploads/${order.artwork_image}`)
      : null;
    if (artworkImageUrl) {
      db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run('第2步：画作一致性检查（确认用的是原作品）', order.id);
      const consistency = await reviewArtworkConsistency(imageUrl, artworkImageUrl);
      if (!consistency.pass) {
        db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run(`第2步未通过：${consistency.reason || '效果图中画作与原作不一致'}`, order.id);
        return { pass: false };
      }
    }

    // 第3步：尺寸比例检查（Max终审）
    if (order.artwork_size) {
      db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run(`第3步：尺寸比例检查（Max终审，${order.artwork_size}）`, order.id);
      const dims = await reviewDimensions(imageUrl, order.artwork_size);
      if (!dims.pass) {
        db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run(`第3步未通过：${dims.reason || '尺寸比例不符'}`, order.id);
        return { pass: false };
      }
      db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run('全部审核通过（物理✓ 画作✓ 尺寸✓）', order.id);
    } else {
      db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run('审核通过（物理✓ 画作✓，无尺寸信息跳过终审）', order.id);
    }

    return { pass: true };
  }

  setInterval(async () => {
    const pending = db.prepare(
      "SELECT id, ai_execution_id, ai_retry_count, ai_user_message, artwork_size FROM orders WHERE status='ai_generating' AND ai_execution_id IS NOT NULL"
    ).all();

    for (const order of pending) {
      try {
        const execResult = await checkExecution(order.ai_execution_id);
        const { status, imageUrl } = execResult;
        const rawKeys = Object.keys(execResult.raw || {}).join(',');
        console.log(`📊 轮询 订单=${order.id} status=${status} imageUrl=${imageUrl} keys=[${rawKeys}]`);
        if (!imageUrl && (status === 'completed' || status === 'succeeded')) {
          console.log(`📋 完整响应: ${JSON.stringify(execResult.raw)}`);
        }

        if (status === 'completed' || status === 'succeeded') {
          const retryCount = order.ai_retry_count || 0;

          if (!imageUrl) {
            if (retryCount < MAX_AI_RETRIES && order.ai_user_message) {
              const userMessage = JSON.parse(order.ai_user_message);
              const newExecId = await submitImageRequest({ userMessage });
              db.prepare("UPDATE orders SET ai_execution_id=?, ai_result_url=NULL, ai_retry_count=?, ai_current_step='图片获取失败，重新提交中…' WHERE id=?")
                .run(newExecId, retryCount + 1, order.id);
            } else {
              db.prepare("UPDATE orders SET status='pending', ai_current_step='图片获取失败，已退回' WHERE id=?").run(order.id);
            }
            continue;
          }

          // Qwen 初审（物理检查）
          db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run(`Qwen初审中（物理合理性检查，第${retryCount+1}次）`, order.id);
          const review = await runQwenReview(order, imageUrl);

          if (!review.pass && retryCount < MAX_AI_RETRIES && order.ai_user_message) {
            const userMessage = JSON.parse(order.ai_user_message);
            const newExecId = await submitImageRequest({ userMessage });
            db.prepare("UPDATE orders SET ai_execution_id=?, ai_result_url=NULL, ai_retry_count=?, ai_current_step=? WHERE id=?")
              .run(newExecId, retryCount + 1, `Qwen审核未通过，重新生图（第${retryCount+1}次）`, order.id);
            console.log(`🔄 Qwen 未通过，重新生成（第 ${retryCount + 1} 次）: 订单=${order.id}`);
          } else {
            if (!review.pass) console.log(`⚠️ 已达最大重试次数 (${MAX_AI_RETRIES})，直接交工作人员: 订单=${order.id}`);
            db.prepare("UPDATE orders SET status='ai_ready', ai_result_url=?, ai_ready_at=datetime('now','localtime'), ai_current_step='审核通过，待管理员确认' WHERE id=?")
              .run(imageUrl, order.id);
            console.log(`✅ AI 生图完成: 订单=${order.id} 图片=${imageUrl}`);
          }

        } else if (status === 'failed' || status === 'cancelled' || status === 'interrupted') {
          db.prepare("UPDATE orders SET status='pending', ai_current_step='AI生图失败' WHERE id=?").run(order.id);
          console.warn(`⚠️ AI 生图失败: 订单=${order.id} 状态=${status}`);
        }
      } catch (e) {
        console.error(`轮询出错 订单=${order.id}:`, e.message);
      }
    }
  }, 30 * 1000);

  console.log('🔄 AI 轮询已启动（每 30 秒，含 Qwen 自动审核）');
}
