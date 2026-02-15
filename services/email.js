// services/email.js —— 邮件发送服务（腾讯云 SES HTTP API）
const { ses } = require('tencentcloud-sdk-nodejs-ses');

// ==========================================
// 腾讯云 SES 客户端
// 【请在 .env 中配置以下参数】
//   TENCENTCLOUD_SECRET_ID   - 腾讯云 API 密钥 ID
//   TENCENTCLOUD_SECRET_KEY  - 腾讯云 API 密钥 Key
//   SES_REGION               - 地域，如 ap-guangzhou 或 ap-hongkong
//   SES_FROM_EMAIL           - 发信地址，如 notice@mail.molink.art
//   SES_FROM_NAME            - 发件人别名，如 Molink
//   SES_ORDER_TEMPLATE_ID    - 订单通知邮件模板 ID（数字）
//   SES_DELIVERY_TEMPLATE_ID - 交付通知邮件模板 ID（数字）
//   ADMIN_EMAIL              - 目标机操作者邮箱
//   BASE_URL                 - 站点地址
// ==========================================

const SesClient = ses.v20201002.Client;

const client = new SesClient({
  credential: {
    secretId: process.env.TENCENTCLOUD_SECRET_ID,
    secretKey: process.env.TENCENTCLOUD_SECRET_KEY,
  },
  region: process.env.SES_REGION || 'ap-guangzhou',
  profile: {
    httpProfile: { reqMethod: 'POST', reqTimeout: 10 },
  },
});

// 构造发件人地址（带别名）
function getFromAddress() {
  const name = process.env.SES_FROM_NAME || 'Molink';
  const email = process.env.SES_FROM_EMAIL || 'notice@mail.molink.art';
  return `${name} <${email}>`;
}

/**
 * 发送新订单通知给目标机操作者
 * @param {Object} order - 订单信息
 *
 * 【对应模板变量（在腾讯云控制台创建模板时使用）】
 *   {{orderId}}        - 订单编号
 *   {{serviceType}}    - 服务类型
 *   {{receiveMethod}}  - 接收方式（如 "邮箱: xxx" 或 "短信: xxx"）
 *   {{extraService}}   - 附加服务（"是" 或 "否"）
 *   {{createdAt}}      - 提交时间
 *   {{adminUrl}}       - 管理后台链接
 */
async function 发送订单通知到目标机(order) {
  // 支持多个邮箱，逗号分隔
  const adminEmails = (process.env.ADMIN_EMAIL || '').split(',').map(e => e.trim()).filter(Boolean);
  if (adminEmails.length === 0) {
    console.error('未配置 ADMIN_EMAIL，跳过订单通知');
    return;
  }

  const templateData = JSON.stringify({
    orderId: String(order.id),
    serviceType: order.service_type_label,
    receiveMethod: `${order.receive_method === 'email' ? '邮箱' : '短信'}: ${order.receive_target}`,
    extraService: order.extra_service ? '是' : '否',
    createdAt: order.created_at,
    adminUrl: `${process.env.BASE_URL}/admin`,
  });

  // 逐个发送（非群发，避免收件人互相可见）
  for (const toEmail of adminEmails) {
    try {
      await client.SendEmail({
        FromEmailAddress: getFromAddress(),
        Destination: [toEmail],
        Subject: `新服务请求：${order.service_type_label} - ${order.created_at}`,
        Template: {
          TemplateID: parseInt(process.env.SES_ORDER_TEMPLATE_ID),
          TemplateData: templateData,
        },
        TriggerType: 1, // 触发类邮件，即时发送
      });
      console.log(`📧 订单通知已发送到目标机邮箱: ${toEmail}`);
    } catch (error) {
      console.error(`发送订单通知邮件失败 (${toEmail}):`, error.message);
    }
  }
}

/**
 * 发送交付通知给用户（邮箱方式）
 * @param {Object} order - 订单信息
 * @param {string} deliveryUrl - 交付页面链接
 *
 * 【对应模板变量】
 *   {{serviceType}}  - 服务类型
 *   {{deliveryUrl}}  - 交付结果链接
 */
async function 发送交付通知到用户邮箱(order, deliveryUrl) {
  try {
    await client.SendEmail({
      FromEmailAddress: getFromAddress(),
      Destination: [order.receive_target],
      Subject: `${order.service_type_label} - ${order.created_at}`,
      Template: {
        TemplateID: parseInt(process.env.SES_DELIVERY_TEMPLATE_ID),
        TemplateData: JSON.stringify({
          serviceType: order.service_type_label,
          deliveryUrl: deliveryUrl,
        }),
      },
      TriggerType: 1,
    });
    console.log(`📧 交付通知已发送到用户邮箱: ${order.receive_target}`);
    return true;
  } catch (error) {
    console.error('发送交付通知邮件失败:', error.message);
    return false;
  }
}

module.exports = { 发送订单通知到目标机, 发送交付通知到用户邮箱 };
