// services/sms.js —— 短信发送服务
// ==========================================
// 本模块封装短信发送能力
// 当前提供阿里云短信和通用HTTP短信接口两种实现
// 【请根据你实际使用的短信服务商修改】
// ==========================================

/**
 * 发送交付通知短信给用户
 * @param {string} phoneNumber - 用户手机号
 * @param {string} deliveryUrl - 交付页面链接
 * @param {string} serviceLabel - 服务类型中文名
 * @returns {boolean} 是否发送成功
 */
async function 发送交付通知短信(phoneNumber, deliveryUrl, serviceLabel) {
  // ==========================================
  // 方案一：阿里云短信（推荐国内使用）
  // 【需要安装依赖：npm install @alicloud/dysmsapi20170525 @alicloud/openapi-client】
  // 【需要在阿里云控制台配置短信签名和模板】
  // 短信模板示例：您的「${service}」已完成，查看链接：${url}
  // ==========================================
  
  try {
    // ---- 阿里云短信实现 ----
    // 取消以下注释并配置即可启用：
    /*
    const Dysmsapi = require('@alicloud/dysmsapi20170525');
    const OpenApi = require('@alicloud/openapi-client');
    
    const config = new OpenApi.Config({
      accessKeyId: process.env.SMS_ACCESS_KEY_ID,
      accessKeySecret: process.env.SMS_ACCESS_KEY_SECRET,
    });
    config.endpoint = 'dysmsapi.aliyuncs.com';
    
    const client = new Dysmsapi.default(config);
    const request = new Dysmsapi.SendSmsRequest({
      phoneNumbers: phoneNumber,
      signName: process.env.SMS_SIGN_NAME,       // 【短信签名】
      templateCode: process.env.SMS_TEMPLATE_CODE, // 【短信模板CODE】
      templateParam: JSON.stringify({
        service: serviceLabel,
        url: deliveryUrl
      })
    });
    
    const response = await client.sendSms(request);
    if (response.body.code === 'OK') {
      console.log(`📱 短信已发送到: ${phoneNumber}`);
      return true;
    } else {
      console.error('❌ 短信发送失败:', response.body.message);
      return false;
    }
    */

    // ---- 当前占位实现（开发阶段）----
    console.log(`📱 [模拟] 短信将发送到 ${phoneNumber}，内容：您的「${serviceLabel}」已完成，查看链接：${deliveryUrl}`);
    // 【正式部署时请取消上方阿里云短信代码的注释，并删除此占位段】
    return true;

  } catch (error) {
    console.error('❌ 短信发送异常:', error.message);
    return false;
  }
}

module.exports = { 发送交付通知短信 };
