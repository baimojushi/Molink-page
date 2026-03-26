// server.js —— Mo:link Design 主服务器
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { 启动定时清理 } = require('./services/cleanup');
const { checkExecution, downloadFile } = require('./services/snaptoshine');

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
// AI 生图结果轮询
// ==========================================
function 启动AI轮询() {
  const db = require('./database');
  const fs = require('fs');
  const path = require('path');
  const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, 'data');
  const DELIVERIES_DIR = path.join(PERSISTENT_ROOT, 'deliveries');

  setInterval(async () => {
    const pending = db.prepare(
      "SELECT id, ai_execution_id FROM orders WHERE status='ai_generating' AND ai_execution_id IS NOT NULL"
    ).all();

    for (const order of pending) {
      try {
        const { status, imageUrl } = await checkExecution(order.ai_execution_id);
        if (status === 'completed' || status === 'succeeded') {
          db.prepare("UPDATE orders SET status='ai_ready', ai_result_url=? WHERE id=?")
            .run(imageUrl, order.id);
          console.log(`✅ AI 生图完成: 订单=${order.id} 图片=${imageUrl}`);
        } else if (status === 'failed' || status === 'cancelled' || status === 'interrupted') {
          db.prepare("UPDATE orders SET status='pending' WHERE id=?").run(order.id);
          console.warn(`⚠️ AI 生图失败: 订单=${order.id} 状态=${status}`);
        }
      } catch (e) {
        console.error(`轮询出错 订单=${order.id}:`, e.message);
      }
    }
  }, 30 * 1000);

  console.log('🔄 AI 轮询已启动（每 30 秒）');
}
