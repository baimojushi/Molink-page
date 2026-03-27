// server.js —— Mo:link Design 主服务器
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { 启动定时清理 } = require('./services/cleanup');
const { submitImageRequest, checkExecution, downloadFile } = require('./services/snaptoshine');
const { reviewPhysics, reviewDimensions } = require('./services/qwen');

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
    // 初审：qwen-vl-flash，512px 缩略图
    const physics = await reviewPhysics(imageUrl);
    if (!physics.pass) return { pass: false };

    // 终审：qwen-vl-max，768px 缩略图（只在有尺寸信息时执行）
    if (order.artwork_size) {
      const dims = await reviewDimensions(imageUrl, order.artwork_size);
      if (!dims.pass) return { pass: false };
    }

    return { pass: true };
  }

  setInterval(async () => {
    const pending = db.prepare(
      "SELECT id, ai_execution_id, ai_retry_count, ai_user_message, artwork_size FROM orders WHERE status='ai_generating' AND ai_execution_id IS NOT NULL"
    ).all();

    for (const order of pending) {
      try {
        const { status, imageUrl } = await checkExecution(order.ai_execution_id);

        if (status === 'completed' || status === 'succeeded') {
          const retryCount = order.ai_retry_count || 0;
          const review = await runQwenReview(order, imageUrl);

          if (!review.pass && retryCount < MAX_AI_RETRIES && order.ai_user_message) {
            // Qwen 未通过且还有重试机会 → 重新提交生图
            const userMessage = JSON.parse(order.ai_user_message);
            const newExecId = await submitImageRequest({ userMessage });
            db.prepare('UPDATE orders SET ai_execution_id=?, ai_result_url=NULL, ai_retry_count=? WHERE id=?')
              .run(newExecId, retryCount + 1, order.id);
            console.log(`🔄 Qwen 未通过，重新生成（第 ${retryCount + 1} 次）: 订单=${order.id}`);
          } else {
            // 通过审核，或已达最大重试次数 → 进入待审核
            if (!review.pass) {
              console.log(`⚠️ 已达最大重试次数 (${MAX_AI_RETRIES})，直接交工作人员: 订单=${order.id}`);
            }
            db.prepare("UPDATE orders SET status='ai_ready', ai_result_url=? WHERE id=?")
              .run(imageUrl, order.id);
            console.log(`✅ AI 生图完成: 订单=${order.id} 图片=${imageUrl}`);
          }

        } else if (status === 'failed' || status === 'cancelled' || status === 'interrupted') {
          db.prepare("UPDATE orders SET status='pending' WHERE id=?").run(order.id);
          console.warn(`⚠️ AI 生图失败: 订单=${order.id} 状态=${status}`);
        }
      } catch (e) {
        console.error(`轮询出错 订单=${order.id}:`, e.message);
      }
    }
  }, 30 * 1000);

  console.log('🔄 AI 轮询已启动（每 30 秒，含 Qwen 自动审核）');
}
