// middleware/upload.js —— 文件上传配置
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// 持久化数据根目录
const PERSISTENT_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(PERSISTENT_ROOT, 'uploads');
const DELIVERIES_DIR = path.join(PERSISTENT_ROOT, 'deliveries');

// ==========================================
// 用户端图片上传配置
// ==========================================
const clientStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    // 文件名格式：类型标记_UUID.扩展名
    const prefix = file.fieldname === 'artwork' ? '作品图' : '空间图';
    cb(null, `${prefix}_${uuidv4()}${ext}`);
  }
});

const clientUpload = multer({
  storage: clientStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 单张最大20MB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|bmp|tiff)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 JPG/PNG/WEBP/BMP/TIFF 格式的图片'));
    }
  }
});

// ==========================================
// 管理端（目标机）回传图片上传配置
// ==========================================
const adminStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, DELIVERIES_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `delivery_${uuidv4()}${ext}`);
  }
});

const adminUpload = multer({
  storage: adminStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 管理端最大50MB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|bmp|tiff)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('仅支持图片格式'));
    }
  }
});

module.exports = { clientUpload, adminUpload };
