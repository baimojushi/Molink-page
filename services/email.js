// services/email.js —— 邮件发送服务
const nodemailer = require('nodemailer');

// ==========================================
// 创建 SMTP 邮件传输器
// 【请在 .env 中配置 SMTP 参数】
// ==========================================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

/**
 * 发送新订单通知给目标机操作者
 * @param {Object} order - 订单信息
 */
async function 发送订单通知到目标机(order) {
  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_USER}>`,
    // 【目标机操作者邮箱，在 .env 中配置 ADMIN_EMAIL】
    to: process.env.ADMIN_EMAIL,
    subject: `新服务请求：${order.service_type_label} - ${order.created_at}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #5a3e2b;">📋 新的服务请求</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; color: #888;">订单编号</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${order.id}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; color: #888;">服务类型</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${order.service_type_label}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; color: #888;">接收方式</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${order.receive_method === 'email' ? '邮箱' : '短信'}: ${order.receive_target}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; color: #888;">附加服务</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${order.extra_service ? '✅ 是' : '❌ 否'}</td></tr>
          <tr><td style="padding: 8px; border-bottom: 1px solid #eee; color: #888;">提交时间</td><td style="padding: 8px; border-bottom: 1px solid #eee;">${order.created_at}</td></tr>
        </table>
        <p style="margin-top: 16px;">
          <a href="${process.env.BASE_URL}/admin" style="display: inline-block; padding: 10px 24px; background: #5a3e2b; color: #fff; text-decoration: none; border-radius: 6px;">进入管理后台处理</a>
        </p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`📧 订单通知已发送到目标机邮箱: ${process.env.ADMIN_EMAIL}`);
  } catch (error) {
    console.error('❌ 发送订单通知邮件失败:', error.message);
  }
}

/**
 * 发送交付通知给用户（邮箱方式）
 * @param {Object} order - 订单信息
 * @param {string} deliveryUrl - 交付页面链接
 */
async function 发送交付通知到用户邮箱(order, deliveryUrl) {
  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_USER}>`,
    to: order.receive_target,
    subject: `${order.service_type_label} - ${order.created_at}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #5a3e2b;">🎨 您的作品已完成</h2>
        <p>您提交的「${order.service_type_label}」服务已处理完毕，请点击下方链接查看并下载：</p>
        <p style="margin: 24px 0;">
          <a href="${deliveryUrl}" style="display: inline-block; padding: 12px 32px; background: #5a3e2b; color: #fff; text-decoration: none; border-radius: 8px; font-size: 16px;">查看交付结果</a>
        </p>
        <p style="color: #888; font-size: 13px;">此链接长期有效，您可随时打开查看。</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`📧 交付通知已发送到用户邮箱: ${order.receive_target}`);
    return true;
  } catch (error) {
    console.error('❌ 发送交付通知邮件失败:', error.message);
    return false;
  }
}

module.exports = { 发送订单通知到目标机, 发送交付通知到用户邮箱 };
