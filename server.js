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
// 每批次生成 EXECUTION_COUNT 张图，全部轮询，收集所有通过审核的效果图
// MAX_AI_RETRIES: 若整批全部未通过，重新提交的最大次数
// ==========================================
function 启动AI轮询() {
  const db = require('./database');
  const MAX_AI_RETRIES = parseInt(process.env.MAX_AI_RETRIES || '3');

  // 单张图片的 Qwen 审核（物理 → 画作一致性 → 尺寸），返回 { pass, reason }
  async function runQwenReview(order, imageUrl) {
    // 第1步：物理合理性
    db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run('物理合理性检查（Flash初审）…', order.id);
    const physics = await reviewPhysics(imageUrl);
    if (!physics.pass) return { pass: false, reason: physics.reason || '画面物理不合理' };

    // 第2步：画作一致性
    const artworkImageUrl = order.artwork_image
      ? (order.artwork_image.startsWith('http') ? order.artwork_image : `https://www.molink.art/uploads/${order.artwork_image}`)
      : null;
    if (artworkImageUrl) {
      db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run('画作一致性检查…', order.id);
      const consistency = await reviewArtworkConsistency(imageUrl, artworkImageUrl);
      if (!consistency.pass) return { pass: false, reason: consistency.reason || '效果图中画作与原作不一致' };
    }

    // 第3步：尺寸比例
    if (order.artwork_size) {
      db.prepare("UPDATE orders SET ai_current_step=? WHERE id=?").run(`尺寸比例检查（${order.artwork_size}）…`, order.id);
      const dims = await reviewDimensions(imageUrl, order.artwork_size);
      if (!dims.pass) return { pass: false, reason: dims.reason || '尺寸比例不符' };
    }

    return { pass: true };
  }

  setInterval(async () => {
    const pending = db.prepare(
      "SELECT id, ai_execution_id, ai_execution_ids, ai_result_urls, ai_retry_count, ai_user_message, artwork_size, artwork_image FROM orders WHERE status='ai_generating' AND (ai_execution_ids IS NOT NULL OR ai_execution_id IS NOT NULL)"
    ).all();

    for (const order of pending) {
      try {
        // 兼容旧订单（只有 ai_execution_id）和新订单（ai_execution_ids 数组）
        let pendingIds;
        try {
          pendingIds = order.ai_execution_ids
            ? JSON.parse(order.ai_execution_ids)
            : (order.ai_execution_id ? [order.ai_execution_id] : []);
        } catch { pendingIds = order.ai_execution_id ? [order.ai_execution_id] : []; }

        let resultUrls = [];
        try { resultUrls = JSON.parse(order.ai_result_urls || '[]'); } catch {}

        if (pendingIds.length === 0) continue;

        const stillPending = [];

        for (const execId of pendingIds) {
          const execResult = await checkExecution(execId);
          const { status, imageUrl } = execResult;
          console.log(`📊 轮询 订单=${order.id.substring(0,8)} exec=${execId.substring(0,8)} status=${status} 有图=${!!imageUrl}`);

          if (status === 'completed' || status === 'succeeded') {
            if (imageUrl) {
              const review = await runQwenReview(order, imageUrl);
              if (review.pass) {
                resultUrls.push(imageUrl);
                console.log(`✅ 通过审核 订单=${order.id.substring(0,8)} 已通过=${resultUrls.length} 张`);
              } else {
                console.log(`❌ 审核未通过（${review.reason}） 订单=${order.id.substring(0,8)}`);
              }
            } else {
              // 完成但没有图片，记录完整响应供排查
              console.log(`⚠️ 完成但无图 订单=${order.id.substring(0,8)} exec=${execId.substring(0,8)}`);
              console.log(`📋 完整响应: ${JSON.stringify(execResult.raw).substring(0, 600)}`);
            }
            // 无论有无图，该 execution 已完成，不再追踪
          } else if (['failed', 'cancelled', 'interrupted'].includes(status)) {
            console.warn(`⚠️ execution 失败 status=${status} 订单=${order.id.substring(0,8)}`);
            // 失败，丢弃
          } else {
            // 仍在运行中，保留在待轮询列表
            stillPending.push(execId);
          }
        }

        if (stillPending.length > 0) {
          // 批次尚未全部完成，更新进度
          db.prepare("UPDATE orders SET ai_execution_ids=?, ai_result_urls=?, ai_current_step=? WHERE id=?")
            .run(
              JSON.stringify(stillPending),
              JSON.stringify(resultUrls),
              `轮询中：${pendingIds.length - stillPending.length}/${pendingIds.length} 已完成，${resultUrls.length} 张通过`,
              order.id
            );
        } else {
          // 整批完成
          if (resultUrls.length > 0) {
            db.prepare(`UPDATE orders SET
              status='ai_ready', ai_execution_ids='[]',
              ai_result_url=?, ai_result_urls=?,
              ai_ready_at=datetime('now','localtime'),
              ai_current_step=?
              WHERE id=?`
            ).run(
              resultUrls[0],
              JSON.stringify(resultUrls),
              `审核完成：${resultUrls.length} 张效果图待管理员确认`,
              order.id
            );
            console.log(`✅ 批次完成 订单=${order.id.substring(0,8)} 通过=${resultUrls.length} 张`);
          } else {
            // 整批全部未通过，考虑重试
            const retryCount = order.ai_retry_count || 0;
            if (retryCount < MAX_AI_RETRIES && order.ai_user_message) {
              const userMessage = JSON.parse(order.ai_user_message);
              const newIds = await submitImageRequest({ userMessage });
              db.prepare(`UPDATE orders SET
                ai_execution_id=?, ai_execution_ids=?,
                ai_result_url=NULL, ai_result_urls='[]',
                ai_retry_count=?, ai_current_step=?
                WHERE id=?`
              ).run(
                newIds[0], JSON.stringify(newIds),
                retryCount + 1,
                `第 ${retryCount + 1} 次重新生成（整批未通过审核）`,
                order.id
              );
              console.log(`🔄 整批未通过，重新生成（第 ${retryCount + 1} 次） 订单=${order.id.substring(0,8)}`);
            } else {
              db.prepare("UPDATE orders SET status='pending', ai_current_step='AI多次生成均未通过审核，请手动处理' WHERE id=?").run(order.id);
              console.warn(`⚠️ 已达最大重试次数，转人工处理 订单=${order.id.substring(0,8)}`);
            }
          }
        }

      } catch (e) {
        console.error(`轮询出错 订单=${order.id}:`, e.message);
      }
    }
  }, 30 * 1000);

  console.log('🔄 AI 轮询已启动（每 30 秒，全批次追踪，含 Qwen 自动审核）');
}
