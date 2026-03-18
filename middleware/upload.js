// middleware/upload.js —— 文件上传配置
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// 持久化数据根目录
const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(PERSISTENT_ROOT, 'uploads');
const DELIVERIES_DIR = path.join(PERSISTENT_ROOT, 'deliveries');

// ==========================================
// 根因修复1：模块加载时确保目录存在
// multer diskStorage 的 destination 回调不会自动创建目录，
// 若目录缺失（如首次部署、容器重建）会直接抛出 ENOENT 导致上传失败
// ==========================================
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DELIVERIES_DIR, { recursive: true });

// ==========================================
// 根因修复2：fileFilter 同时校验扩展名和 MIME type
// iOS/Android 浏览器上传时 originalname 可能无扩展名（如 "image"、"blob"），
// 仅靠扩展名校验会误拒合法图片；加入 MIME type 校验作为兜底
// ==========================================
const ALLOWED_EXT = /\.(jpg|jpeg|png|webp|bmp|tiff)$/i;
const ALLOWED_MIME = /^image\/(jpeg|png|webp|bmp|tiff)$/i;

function imageFilter(req, file, cb) {
  const extOk = ALLOWED_EXT.test(path.extname(file.originalname));
  const mimeOk = ALLOWED_MIME.test(file.mimetype);
  if (extOk || mimeOk) {
    cb(null, true);
  } else {
    cb(new Error('仅支持 JPG/PNG/WebP/BMP/TIFF 格式的图片'));
  }
}

// ==========================================
// 根因修复3：客户端文件名改为纯 ASCII
// 中文文件名在某些 Railway 环境或 URL 访问时可能触发编码异常
// ==========================================
const CLIENT_PREFIX = { artwork: 'artwork', space: 'space' };

// ==========================================
// 用户端图片上传配置
// ==========================================
const clientStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const prefix = CLIENT_PREFIX[file.fieldname] || 'img';
    cb(null, `${prefix}_${uuidv4()}${ext}`);
  }
});

const clientUpload = multer({
  storage: clientStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 单张最大 20MB
  fileFilter: imageFilter,
});

// ==========================================
// 管理端（目标机）回传图片上传配置
// ==========================================
const adminStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, DELIVERIES_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `delivery_${uuidv4()}${ext}`);
  }
});

const adminUpload = multer({
  storage: adminStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 管理端最大 50MB
  fileFilter: imageFilter,
});

module.exports = { clientUpload, adminUpload, DELIVERIES_DIR };
