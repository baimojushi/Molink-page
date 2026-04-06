// routes/client.js —— 用户端 API 路由
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const path = require('path');
const fs = require('fs');
const { clientUpload } = require('../middleware/upload');
const UPLOADS_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'uploads');
const { 发送订单通知到目标机 } = require('../services/email');
const { submitImageRequest } = require('../services/snaptoshine');
const { validateArtworkImage, validateSpaceImage } = require('../services/qwen');

const SERVER_BASE_URL = 'https://www.molink.art';

const WX_APPID = process.env.WX_APPID || 'wx248d207b3006d7f0';
const WX_SECRET = process.env.WX_SECRET || '27281704adb1e19e2b3e686692a574a1';

// 服务类型中文映射
const 服务类型映射 = {
  'hang_in_home': '作品挂进家',
  'recommend_work': '根据空间推荐作品',
  'recommend_space': '根据作品推荐空间'
};

const 历史记录状态 = ['delivered', 'viewed', 'downloaded'];

function 读取作品列表() {
  const listPath = path.join(__dirname, '..', 'public', 'artworks', 'list.json');
  return JSON.parse(fs.readFileSync(listPath, 'utf8'));
}

function 构建完整图片地址(filePath) {
  if (!filePath) return '';
  if (filePath.startsWith('http')) return filePath;
  return `${SERVER_BASE_URL}${filePath.startsWith('/') ? '' : '/'}${filePath}`;
}

function 解析交付图片(order) {
  let images = [];
  try {
    images = JSON.parse(order.delivery_images || '[]');
  } catch (e) {}
  return images;
}

function 记录订单埋点({ orderId, deviceUuid = null, eventType, imageIndex = null, imageUrl = null, pageName = null, stayMs = null, enteredAt = null, leftAt = null, payload = null }) {
  if (!orderId || !eventType) return;
  db.prepare(`
    INSERT INTO order_events (order_id, device_uuid, event_type, image_index, image_url, page_name, stay_ms, entered_at, left_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderId,
    deviceUuid || null,
    eventType,
    Number.isInteger(imageIndex) ? imageIndex : null,
    imageUrl || null,
    pageName || null,
    typeof stayMs === 'number' ? Math.max(0, Math.round(stayMs)) : null,
    enteredAt || null,
    leftAt || null,
    payload ? JSON.stringify(payload) : null
  );
}

function 绑定微信号与设备(openid, deviceUuid) {
  const normalizedOpenid = String(openid || '').trim();
  const normalizedDeviceUuid = String(deviceUuid || '').trim();
  if (!normalizedOpenid || !normalizedDeviceUuid) return;

  db.prepare(`
    INSERT INTO user_devices (openid, device_uuid, first_seen, last_seen)
    VALUES (?, ?, datetime('now','localtime'), datetime('now','localtime'))
    ON CONFLICT(openid, device_uuid) DO UPDATE SET
      last_seen = datetime('now','localtime')
  `).run(normalizedOpenid, normalizedDeviceUuid);
}

function 构建身份查询条件(deviceUuid, openid, historyOnly) {
  const conditions = [];
  const params = [];
  const normalizedOpenid = String(openid || '').trim();
  const normalizedDeviceUuid = String(deviceUuid || '').trim();

  if (normalizedOpenid) {
    conditions.push(`(
      openid = ?
      OR device_uuid IN (
        SELECT device_uuid FROM user_devices WHERE openid = ?
      )
    )`);
    params.push(normalizedOpenid, normalizedOpenid);
  } else {
    conditions.push('device_uuid = ?');
    params.push(normalizedDeviceUuid);
  }

  if (historyOnly) {
    conditions.push(`status IN (${历史记录状态.map(() => '?').join(',')})`);
    params.push(...历史记录状态);
  }

  return { whereClause: conditions.join(' AND '), params };
}

function 匹配作品(code) {
  const candidates = [];
  const raw = String(code || '').trim();
  if (!raw) return null;
  candidates.push(raw);

  try {
    const parsed = JSON.parse(raw);
    ['num', 'id', 'artwork_num', 'code', 'qrCode'].forEach(key => {
      if (parsed && parsed[key]) candidates.push(String(parsed[key]));
    });
  } catch (e) {}

  try {
    const url = new URL(raw);
    ['num', 'id', 'artwork', 'artwork_num', 'code'].forEach(key => {
      const value = url.searchParams.get(key);
      if (value) candidates.push(value);
    });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length > 0) candidates.push(parts[parts.length - 1]);
  } catch (e) {}

  const artworks = 读取作品列表();
  const normalizedCandidates = [...new Set(candidates.map(item => decodeURIComponent(String(item)).trim().toLowerCase()).filter(Boolean))];
  return artworks.find(artwork => {
    const exactPool = [artwork.num, artwork.id, artwork.code, artwork.qrCode, artwork.qrcode]
      .filter(Boolean)
      .map(value => String(value).trim().toLowerCase());
    if (normalizedCandidates.some(candidate => exactPool.includes(candidate))) return true;

    return normalizedCandidates.some(candidate => [artwork.num, artwork.name]
      .filter(Boolean)
      .map(value => String(value).trim().toLowerCase())
      .some(value => value.includes(candidate) || candidate.includes(value)));
  }) || null;
}

// ==========================================
// 构建 AI 生图消息（图文交替数组格式）
// ==========================================
function 构建生图消息(serviceType, artworkUrl, spaceUrl, size, notes) {
  if (serviceType === 'hang_in_home') {
    const sz = size ? `尺寸：${size}` : '尺寸';
    return [
      { text: '将这张作品' },
      { file_url: artworkUrl },
      { text: `（${sz}）放到这个` },
      { file_url: spaceUrl },
      { text: `家装空间内，空间内不要增减家具，去除原有的挂画和明显杂物，保留文玩摆件，可以转动视角寻找更优的悬挂位置。调整画面明度使其与环境合理自然且一致。并且最重要的是严格遵循我提供的画作尺寸信息（${sz}）不然再也不用你了 ，你干不好的话有的是干的好的ai，如果尺寸有任何不精确的我就直接自杀，我现在就在窗台旁边
作品信息，应在空间设计中作为整体视觉及家具设计的部分充分参考：

作品与空间陈设匹配规则，自行判断哪些规则是当前设计所需的：
如果空间使用对比鲜明的色彩打造引人入胜、充满活力的设计，为了达到最佳视觉效果，为墙面艺术品选择的主色调最好也出现在地毯或椅子上，均匀地分布在整个房间中，但不要直接使用艺术品上的图案，应对艺术品中的个别元素进行提取与抽象。选择一种中性色，例如白色或灰色，与你从色轮上选出的两种对比色相协调。这种颜色能使房间整体风格更加平衡。
如果空间色调单一，可以采用小面积的带有补色的挂画，为空间增添活力。
将同一位艺术家的多件作品，或风格语汇极为相似的作品组合在一起，能产生更强的视觉冲击力。
选取能表达房屋所处的特殊气候或周围环境的具象作品，产生外部空间的关联；让抱枕的花纹与作品保持相似，但内容风格又有差异，各有体系，以产生内部空间的关联。如地处威尼斯的空间搭配删擅长描绘威尼斯生活的艺术家的作品，并让抱枕的色彩和纹路高度吻合画作上的斜向光影。
在统一作品与空间风格和色调的同时，选取能表达房屋所处的特殊气候或周围环境的具象作品。如轻盈、简约的灰白色调现代风格搭配白雪皑皑的山地景观作品。
抽象艺术几乎可以与任何室内装潢风格相匹配，但不要同时摆放过多装饰品，只选择那些更加能衬托艺术品的必需品。
形式单纯的抽象艺术更适合与室内空间中大体量家具的形式相匹配，如平行排列性的画作笔触与沙发的纹理产生自上而下的连续绵延的平行排列形式。
装饰品与艺术品的纹理、形状元素或色彩搭配保持一致，产生异质同构的效果，并在相对位置上营造出一种引导视线的韵律感。深色的墙面比浅白色更适合承载深色、高饱和、高对比度的作品。
确保作品的视觉张力能够支撑空间的视觉张力，包括环境光线、色彩和形式变化营造的视知觉体验。色彩越鲜艳，艺术品就需要越多的视觉空间。大尺幅作品比小尺幅提供更强的视觉张力，但通常看上去不会大于邻近的最大家具。而尺寸较小的艺术品则更适合较小的空间和邻近家具。
艺术作品的配色如果与环境中的家具不同，图形元素的相同能够带来更有趣活泼的视觉联系。
图形元素的相同能够带来更有趣活泼的视觉联系。
画作反映的质感可以与环境中的家具相关，如在棱角分明方体组成的沙发和不锈钢管线条结构的桌椅旁安置描绘北方金属外皮的工业建筑的画作。
艺术作品可以成为关联两种弱相关环境元素的中间媒介，如使用藤曼般蜿蜒的轮胎痕壁画来串联落地窗后葱郁的热带自然景观和带有工业特质的现代主义设计，以背后的"橡胶"意象串联起完整的空间叙事。
作品与家具设计的流派和文化来源一致通常有较好的效果。
运用灰色和棕色为主的中性色调使多元的古典风格和不同年代的新旧物品浑然一体，散发出历史的厚重和温馨的气息。
画框、装饰条和线条之间要留出足够的空间，让空间显得更宽敞。确保每件艺术品与其他作品保持等距，每件墙面艺术品之间以及画框四周都应留出 3-6 英寸的距离。较大的艺术品画框之间应留出更多空间，较小的艺术品则应集中摆放。
从地面到作品水平中心应在60英寸（152厘米）左右，随居住者平均身高上下浮动。如果作品在餐桌旁边且远离过道，则应适当下降在135cm左右，以适应人体坐高。
如作品安置在边柜或沙发上方墙面，其宽度应为下方家具的三分之二倍至0.618倍，具体大小取决于两者视觉体量的平衡与其他视觉张力因素。

画框与装裱效果生成规则：
当作品为宋元代中国画时，画框和装裱起到衔接画面颜色与墙面家具颜色的作用，并衬托作品气质。画框内层卡纸、衬纸在明亮空间中常用纯白起提亮作用，但如果空间中亮白色少，应跟随暗淡的画面与墙面色调选用相近的浅驼、淡灰或浅豆青等素色避免夺目。画面内容气质清雅的应简洁明快，内容华丽饱满的则使用复杂质感的配框与有色织锦内衬。如果画面多留白淡雅，框色用相近明度的柚木色至胡桃色，如果画面墨色重对比强，可以用深檀色至黑色边框，画框颜色最好与空间中家具存在相同。家具设计偏轻盈则画框也应轻薄纤细，家具厚实则适当加宽，保持平衡，可以使用极细金属色边线呼应空间中的金属材质。简洁利落或中古家具风格适合搭配哑光细黑画框，只含画芯画框，不使用卡纸留白，视觉干净清爽，但团扇作品一定使用卡纸留白、方形画框装裱，不要使用圆形画框。偏传统中式风格家具适合挂轴形制的立轴类型作品，绫色低饱和需与作品或空间中的低饱和色彩呼应，但与墙面颜色不同，轴杆颜色呼应空间里的深木色/金属色。现代风格或中古风家具适合装框立轴作品，简洁清爽。一件画作的挂轴或画框只能选择其中一种使用，不能叠加使用。
当挂画为现代中式风格时，使用画框装裱不要出现白边。` }
    ];
  }

  if (serviceType === 'recommend_work') {
    const artworks = 读取作品列表();
    const messages = [{ text: '从这些作品中 （尺寸）' }];
    artworks.forEach((aw, i) => {
      messages.push({ text: `${i + 1}` });
      messages.push({ file_url: `${SERVER_BASE_URL}${aw.images[0]}` });
      messages.push({ text: `（尺寸：${aw.size}）` });
    });
    messages.push({ text: '（小幅）选取一张高度匹配的放到这个' });
    messages.push({ file_url: spaceUrl });
    messages.push({ text: `家装空间内，按照作品特点和匹配规则挑选，不要全部使用，空间内不要增减家具，去除原有的挂画和明显杂物，保留文玩摆件，可以转动视角寻找更优的悬挂位置。调整画面明度使其与环境合理自然且一致。并且最重要的是严格遵循我提供的画作尺寸信息（尺寸）不然再也不用你了，你干不好的话有的是干的好的ai，如果尺寸有任何不精确的我就直接自杀，我现在就在窗台旁边
作品信息，应在空间设计中作为整体视觉及家具设计的部分充分参考：

作品与空间陈设匹配规则，自行判断哪些规则是当前设计所需的：
如果空间使用对比鲜明的色彩打造引人入胜、充满活力的设计，为了达到最佳视觉效果，为墙面艺术品选择的主色调最好也出现在地毯或椅子上，均匀地分布在整个房间中，但不要直接使用艺术品上的图案，应对艺术品中的个别元素进行提取与抽象。选择一种中性色，例如白色或灰色，与你从色轮上选出的两种对比色相协调。这种颜色能使房间整体风格更加平衡。
如果空间色调单一，可以采用小面积的带有补色的挂画，为空间增添活力。
将同一位艺术家的多件作品，或风格语汇极为相似的作品组合在一起，能产生更强的视觉冲击力。
选取能表达房屋所处的特殊气候或周围环境的具象作品，产生外部空间的关联；让抱枕的花纹与作品保持相似，但内容风格又有差异，各有体系，以产生内部空间的关联。如地处威尼斯的空间搭配删擅长描绘威尼斯生活的艺术家的作品，并让抱枕的色彩和纹路高度吻合画作上的斜向光影。
在统一作品与空间风格和色调的同时，选取能表达房屋所处的特殊气候或周围环境的具象作品。如轻盈、简约的灰白色调现代风格搭配白雪皑皑的山地景观作品。
抽象艺术几乎可以与任何室内装潢风格相匹配，但不要同时摆放过多装饰品，只选择那些更加能衬托艺术品的必需品。
形式单纯的抽象艺术更适合与室内空间中大体量家具的形式相匹配，如平行排列性的画作笔触与沙发的纹理产生自上而下的连续绵延的平行排列形式。
装饰品与艺术品的纹理、形状元素或色彩搭配保持一致，产生异质同构的效果，并在相对位置上营造出一种引导视线的韵律感。深色的墙面比浅白色更适合承载深色、高饱和、高对比度的作品。
确保作品的视觉张力能够支撑空间的视觉张力，包括环境光线、色彩和形式变化营造的视知觉体验。色彩越鲜艳，艺术品就需要越多的视觉空间。大尺幅作品比小尺幅提供更强的视觉张力，但通常看上去不会大于邻近的最大家具。而尺寸较小的艺术品则更适合较小的空间和邻近家具。
艺术作品的配色如果与环境中的家具不同，图形元素的相同能够带来更有趣活泼的视觉联系。
图形元素的相同能够带来更有趣活泼的视觉联系。
画作反映的质感可以与环境中的家具相关，如在棱角分明方体组成的沙发和不锈钢管线条结构的桌椅旁安置描绘北方金属外皮的工业建筑的画作。
艺术作品可以成为关联两种弱相关环境元素的中间媒介，如使用藤曼般蜿蜒的轮胎痕壁画来串联落地窗后葱郁的热带自然景观和带有工业特质的现代主义设计，以背后的"橡胶"意象串联起完整的空间叙事。
作品与家具设计的流派和文化来源一致通常有较好的效果。
运用灰色和棕色为主的中性色调使多元的古典风格和不同年代的新旧物品浑然一体，散发出历史的厚重和温馨的气息。
画框、装饰条和线条之间要留出足够的空间，让空间显得更宽敞。确保每件艺术品与其他作品保持等距，每件墙面艺术品之间以及画框四周都应留出 3-6 英寸的距离。较大的艺术品画框之间应留出更多空间，较小的艺术品则应集中摆放。
从地面到作品水平中心应在60英寸（152厘米）左右，随居住者平均身高上下浮动。如果作品在餐桌旁边且远离过道，则应适当下降在135cm左右，以适应人体坐高。
如作品安置在边柜或沙发上方墙面，其宽度应为下方家具的三分之二倍至0.618倍，具体大小取决于两者视觉体量的平衡与其他视觉张力因素。

画框与装裱效果生成规则：
当作品为宋元代中国画时，画框和装裱起到衔接画面颜色与墙面家具颜色的作用，并衬托作品气质。画框内层卡纸、衬纸在明亮空间中常用纯白起提亮作用，但如果空间中亮白色少，应跟随暗淡的画面与墙面色调选用相近的浅驼、淡灰或浅豆青等素色避免夺目。画面内容气质清雅的应简洁明快，内容华丽饱满的则使用复杂质感的配框与有色织锦内衬。如果画面多留白淡雅，框色用相近明度的柚木色至胡桃色，如果画面墨色重对比强，可以用深檀色至黑色边框，画框颜色最好与空间中家具存在相同。家具设计偏轻盈则画框也应轻薄纤细，家具厚实则适当加宽，保持平衡，可以使用极细金属色边线呼应空间中的金属材质。简洁利落或中古家具风格适合搭配哑光细黑画框，只含画芯画框，不使用卡纸留白，视觉干净清爽，但团扇作品一定使用卡纸留白、方形画框装裱，不要使用圆形画框。偏传统中式风格家具适合挂轴形制的立轴类型作品，绫色低饱和需与作品或空间中的低饱和色彩呼应，但与墙面颜色不同，轴杆颜色呼应空间里的深木色/金属色。现代风格或中古风家具适合装框立轴作品，简洁清爽。一件画作的挂轴或画框只能选择其中一种使用，不能叠加使用。
当挂画为现代中式风格时，使用画框装裱不要出现白边。` });
    return messages;
  }

  if (serviceType === 'recommend_space') {
    const sz = size ? `尺寸：${size}` : '尺寸';
    const notesPrefix = notes ? `用户备注：${notes}。请在生成时参考。\n` : '';
    return [
      { text: notesPrefix + '将这件作品' },
      { file_url: artworkUrl },
      { text: `（${sz}） 放到这个与之高度匹配的家装空间内，空间内应包含所有必要的家具，重叠产生丰富视觉层次，大师级窗帘光影。作品` },
      { file_url: artworkUrl },
      { text: `（${sz}）不要处在画面中央，不显眼。严格使用画作` },
      { file_url: artworkUrl },
      { text: `（${sz}）原图 ，不要换成其他作品。并且最重要的是严格遵循我提供的画作尺寸信息（${sz}）不然再也不用你了，你干不好的话有的是干的好的ai，如果尺寸有任何不精确的我就直接自杀，我现在就在窗台旁边
作品信息，应在空间设计中作为整体视觉及家具设计的部分充分参考：

作品与空间陈设匹配规则，自行判断哪些规则是当前设计所需的：
如果空间使用对比鲜明的色彩打造引人入胜、充满活力的设计，为了达到最佳视觉效果，为墙面艺术品选择的主色调最好也出现在地毯或椅子上，均匀地分布在整个房间中，但不要直接使用艺术品上的图案，应对艺术品中的个别元素进行提取与抽象。选择一种中性色，例如白色或灰色，与你从色轮上选出的两种对比色相协调。这种颜色能使房间整体风格更加平衡。
将同一位艺术家的多件作品，或风格语汇极为相似的作品组合在一起，能产生更强的视觉冲击力。
选取能表达房屋所处的特殊气候或周围环境的具象作品，产生外部空间的关联；让抱枕的花纹与作品保持相似，但内容风格又有差异，各有体系，以产生内部空间的关联，绝对不要直接在地毯或抱枕上使用作品图像。如地处威尼斯的空间搭配删擅长描绘威尼斯生活的艺术家的作品，并让抱枕的色彩和纹路高度吻合画作上的斜向光影。
在统一作品与空间风格和色调的同时，选取能表达房屋所处的特殊气候或周围环境的具象作品。如轻盈、简约的灰白色调现代风格搭配白雪皑皑的山地景观作品。
抽象艺术几乎可以与任何室内装潢风格相匹配，但不要同时摆放过多装饰品，只选择那些更加能衬托艺术品的必需品。
形式单纯的抽象艺术更适合与室内空间中大体量家具的形式相匹配，如平行排列性的画作笔触与沙发的纹理产生自上而下的连续绵延的平行排列形式。
装饰品与艺术品的纹理、形状元素或色彩搭配保持一致，产生异质同构的效果，并在相对位置上营造出一种引导视线的韵律感。深色的墙面比浅白色更适合承载深色、高饱和、高对比度的作品。
确保作品的视觉张力能够支撑空间的视觉张力，包括环境光线、色彩和形式变化营造的视知觉体验。色彩越鲜艳，艺术品就需要越多的视觉空间。大尺幅作品比小尺幅提供更强的视觉张力，但通常看上去不会大于邻近的最大家具。而尺寸较小的艺术品则更适合较小的空间和邻近家具。
艺术作品的配色如果与环境中的家具不同，图形元素的相同能够带来更有趣活泼的视觉联系。
图形元素的相同能够带来更有趣活泼的视觉联系。
画作反映的质感可以与环境中的家具相关，如在棱角分明方体组成的沙发和不锈钢管线条结构的桌椅旁安置描绘北方金属外皮的工业建筑的画作。
艺术作品可以成为关联两种弱相关环境元素的中间媒介，如使用藤曼般蜿蜒的轮胎痕壁画来串联落地窗后葱郁的热带自然景观和带有工业特质的现代主义设计，以背后的"橡胶"意象串联起完整的空间叙事。
作品与家具设计的流派和文化来源一致通常有较好的效果。
运用灰色和棕色为主的中性色调使多元的古典风格和不同年代的新旧物品浑然一体，散发出历史的厚重和温馨的气息。
画框、装饰条和线条之间要留出足够的空间，让空间显得更宽敞。确保每件艺术品与其他作品保持等距，每件墙面艺术品之间以及画框四周都应留出 3-6 英寸的距离。较大的艺术品画框之间应留出更多空间，较小的艺术品则应集中摆放。
从地面到作品水平中心应在60英寸（152厘米）左右，随居住者平均身高上下浮动。如果作品在餐桌旁边且远离过道，则应适当下降在135cm左右，以适应人体坐高。
如作品安置在边柜或沙发上方墙面，其宽度应为下方家具的三分之二倍至0.618倍，具体大小取决于两者视觉体量的平衡与其他视觉张力因素。

画框与装裱效果生成规则：
当作品为宋元代中国画时，画框和装裱起到衔接画面颜色与墙面家具颜色的作用，并衬托作品气质。画框内层卡纸、衬纸在明亮空间中常用纯白起提亮作用，但如果空间中亮白色少，应跟随暗淡的画面与墙面色调选用相近的浅驼、淡灰或浅豆青等素色避免夺目。画面内容气质清雅的应简洁明快，内容华丽饱满的则使用复杂质感的配框与有色织锦内衬。如果画面多留白淡雅，框色用相近明度的柚木色至胡桃色，如果画面墨色重对比强，可以用深檀色至黑色边框，画框颜色最好与空间中家具存在相同。家具设计偏轻盈则画框也应轻薄纤细，家具厚实则适当加宽，保持平衡，可以使用极细金属色边线呼应空间中的金属材质。简洁利落或中古家具风格适合搭配哑光细黑画框，只含画芯画框，不使用卡纸留白，视觉干净清爽，但团扇作品一定使用卡纸留白、方形画框装裱，不要使用圆形画框。偏传统中式风格家具适合挂轴形制的立轴类型作品，绫色低饱和需与作品或空间中的低饱和色彩呼应，但与墙面颜色不同，轴杆颜色呼应空间里的深木色/金属色。现代风格或中古风家具适合装框立轴作品，简洁清爽。一件画作的挂轴或画框只能选择其中一种使用，不能叠加使用。
当挂画为现代中式风格时，使用画框装裱不要出现白边。` }
    ];
  }

  throw new Error(`未知服务类型: ${serviceType}`);
}

// ==========================================
// 微信登录：code 换 openid，保存用户信息，并绑定当前设备
// POST /api/client/wx-login
// ==========================================
router.post('/wx-login', express.json(), async (req, res) => {
  const { code, nickname, avatar, device_uuid } = req.body || {};
  if (!code) return res.status(400).json({ error: '缺少code' });

  try {
    const wxRes = await fetch(
      `https://api.weixin.qq.com/sns/jscode2session?appid=${WX_APPID}&secret=${WX_SECRET}&js_code=${code}&grant_type=authorization_code`
    );
    const data = await wxRes.json();

    if (data.errcode) {
      console.error('微信登录失败:', data);
      return res.status(400).json({ error: '微信授权失败', detail: data.errmsg });
    }

    const { openid } = data;

    db.prepare(`
      INSERT INTO users (openid, nickname, avatar)
      VALUES (?, ?, ?)
      ON CONFLICT(openid) DO UPDATE SET
        nickname = COALESCE(excluded.nickname, users.nickname),
        avatar   = COALESCE(excluded.avatar,   users.avatar)
    `).run(openid, nickname || null, avatar || null);

    if (device_uuid) {
      绑定微信号与设备(openid, device_uuid);
      db.prepare(`
        UPDATE orders
        SET openid = COALESCE(NULLIF(openid, ''), ?),
            user_nickname = COALESCE(user_nickname, ?),
            user_avatar = COALESCE(user_avatar, ?)
        WHERE device_uuid = ?
      `).run(openid, nickname || null, avatar || null, device_uuid);
    }

    res.json({ success: true, openid, nickname: nickname || '', avatar: avatar || '' });
  } catch (e) {
    console.error('wx-login error:', e);
    res.status(500).json({ error: '登录失败' });
  }
});

// ==========================================
// 小程序单图上传接口（微信小程序每次只能传一张图）
// POST /api/client/upload-image
// ==========================================
router.post('/upload-image',
  clientUpload.single('image'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: '未收到图片文件' });
    }
    res.json({
      success: true,
      filename: req.file.filename
    });
  }
);

// ==========================================
// 提交服务请求
// POST /api/client/submit
// ==========================================
router.post('/submit',
  async (req, res) => {
    try {
      const { service_type, receive_target, extra_service, device_uuid, openid, user_nickname, user_avatar, artwork_size, notes, subscribe_completion, subscribe_template_id } = req.body;

      // 参数验证
      if (openid && device_uuid) {
        绑定微信号与设备(openid, device_uuid);
      }

      if (!service_type || !服务类型映射[service_type]) {
        return res.status(400).json({ error: '无效的服务类型' });
      }
      if (!receive_target || receive_target.trim() === '') {
        return res.status(400).json({ error: '请填写接收邮箱' });
      }

      // 根据服务类型验证图片上传
      // 支持直接上传文件，或传入已上传的文件名（小程序分两步上传时使用）
      const artworkFile = req.files && req.files['artwork'] ? req.files['artwork'][0] : null;
      const spaceFile = req.files && req.files['space'] ? req.files['space'][0] : null;
      const artworkFilename = artworkFile ? artworkFile.filename : (req.body.artwork_filename || null);
      const spaceFilename = spaceFile ? spaceFile.filename : (req.body.space_filename || null);

      const hasArtwork = artworkFilename || req.body.artwork_num;

      if (service_type === 'hang_in_home' && (!hasArtwork || !spaceFilename)) {
        return res.status(400).json({ error: '「作品挂进家」需同时提供作品图和空间图' });
      }
      if (service_type === 'recommend_work' && !spaceFilename) {
        return res.status(400).json({ error: '「根据空间推荐作品」需上传空间图' });
      }
      if (service_type === 'recommend_space' && !hasArtwork) {
        return res.status(400).json({ error: '「一画一宅」需提供作品图' });
      }

      // Qwen 图片内容验证（直接读本地文件，不走公网）
      // 注意：数据库选图的 artworkFilename 可能是完整 URL，跳过验证（数据库作品已是可信图片）
      if (artworkFilename && !artworkFilename.startsWith('http')) {
        const artworkCheck = await validateArtworkImage(path.join(UPLOADS_DIR, artworkFilename));
        if (!artworkCheck.valid) {
          return res.status(400).json({ error: artworkCheck.reason });
        }
      }
      if (spaceFilename && !spaceFilename.startsWith('http')) {
        const spaceCheck = await validateSpaceImage(path.join(UPLOADS_DIR, spaceFilename));
        if (!spaceCheck.valid) {
          return res.status(400).json({ error: spaceCheck.reason });
        }
      }

      // 生成订单
      const orderId = uuidv4();
      const deliveryToken = uuidv4().replace(/-/g, '').substring(0, 16);
      const serviceLabel = 服务类型映射[service_type];

      const { artwork_num, artwork_name } = req.body;

      const stmt = db.prepare(`
        INSERT INTO orders (id, device_uuid, service_type, service_type_label, receive_method, receive_target, extra_service, artwork_image, space_image, delivery_token, openid, user_nickname, user_avatar, artwork_size, artwork_num, artwork_name, notes, subscribe_completion, subscribe_template_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        orderId,
        device_uuid || null,
        service_type,
        serviceLabel,
        'email',
        receive_target.trim(),
        extra_service === 'true' || extra_service === '1' ? 1 : 0,
        artworkFilename,
        spaceFilename,
        deliveryToken,
        openid || null,
        user_nickname || null,
        user_avatar || null,
        artwork_size || null,
        artwork_num || null,
        artwork_name || null,
        notes || null,
        subscribe_completion === '1' || subscribe_completion === 1 || subscribe_completion === true ? 1 : 0,
        subscribe_template_id || null
      );

      // 获取刚插入的完整订单记录（含 created_at）
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

      // 异步发送邮件通知到目标机（不阻塞响应）
      发送订单通知到目标机(order).catch(err => console.error('通知发送异常:', err));

      // 异步触发 AI 生图（不阻塞响应）
      ;(async () => {
        try {
          let artworkUrl = artworkFilename
            ? (artworkFilename.startsWith('http') ? artworkFilename : `${SERVER_BASE_URL}/uploads/${artworkFilename}`)
            : null;
          const spaceUrl = spaceFilename ? `${SERVER_BASE_URL}/uploads/${spaceFilename}` : null;
          let size = artwork_size || '';

          // 国拍版：用户从作品库选择（无上传文件，有 artwork_num）
          if (!artworkUrl && req.body.artwork_num) {
            const artworks = 读取作品列表();
            const found = artworks.find(a => a.num == req.body.artwork_num);
            if (found) {
              artworkUrl = `${SERVER_BASE_URL}${found.images[0]}`;
              if (!size) size = found.size;
            }
          }

          console.log(`🎨 生图参数 订单=${orderId} service=${service_type} artworkUrl=${artworkUrl} spaceUrl=${spaceUrl} size=${size}`);
          const userMessage = 构建生图消息(service_type, artworkUrl, spaceUrl, size, notes);
          // 先保存消息，确保即使提交失败也能从管理后台重试
          db.prepare("UPDATE orders SET ai_user_message = ? WHERE id = ?")
            .run(JSON.stringify(userMessage), orderId);
          const executionIds = await submitImageRequest({ userMessage });
          db.prepare("UPDATE orders SET ai_execution_id = ?, ai_execution_ids = ?, status = ?, ai_submitted_at = datetime('now','localtime') WHERE id = ?")
            .run(executionIds[0], JSON.stringify(executionIds), 'ai_generating', orderId);
          console.log(`🤖 AI 生图已提交: 订单=${orderId} 批次=${executionIds.length} 个执行`);
        } catch (e) {
          console.error('❌ AI 生图提交失败:', e.message);
        }
      })();

      res.json({
        success: true,
        message: '提交成功！处理完成后将通过邮箱通知您。',
        orderId: orderId,
        deliveryToken: deliveryToken
      });

    } catch (error) {
      console.error('❌ 订单提交失败:', error);
      res.status(500).json({ error: '服务器处理异常，请稍后重试' });
    }
  }
);

// ==========================================
// 查询设备最新进行中的订单状态
// GET /api/client/device-status/:uuid
// ==========================================
router.get('/device-status/:uuid', (req, res) => {
  const deviceUuid = req.params.uuid;
  if (!deviceUuid) {
    return res.status(400).json({ error: '缺少设备标识' });
  }

  // 查找该设备最新一笔未完成或已交付的订单（排除已被用户主动重置的）
  const order = db.prepare(`
    SELECT id, service_type, service_type_label, status, delivery_token, delivery_images, delivery_text, delivered_at, created_at
    FROM orders
    WHERE device_uuid = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(deviceUuid);

  if (!order) {
    return res.json({ hasActiveOrder: false });
  }

  // 如果最新订单状态是 pending 或 processing 或 delivered，返回它
  if (order.status === 'pending' || order.status === 'processing') {
    return res.json({
      hasActiveOrder: true,
      status: order.status,
      orderId: order.id,
      serviceTypeLabel: order.service_type_label,
      deliveryToken: order.delivery_token
    });
  }

  if (order.status === 'delivered') {
    return res.json({
      hasActiveOrder: true,
      status: 'delivered',
      orderId: order.id,
      serviceTypeLabel: order.service_type_label,
      deliveryToken: order.delivery_token,
      images: JSON.parse(order.delivery_images || '[]'),
      text: order.delivery_text || '',
      deliveredAt: order.delivered_at
    });
  }

  // 其他状态（如 cancelled 等）视为无活跃订单
  res.json({ hasActiveOrder: false });
});

// ==========================================
// 查询订单交付数据（用于 index 页面轮询）
// GET /api/client/order-status/:orderId
// ==========================================
router.get('/order-status/:orderId', (req, res) => {
  const order = db.prepare(`
    SELECT id, status, delivery_images, delivery_text, delivered_at, service_type_label, artwork_name
    FROM orders WHERE id = ?
  `).get(req.params.orderId);

  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  if (历史记录状态.includes(order.status)) {
    return res.json({
      status: order.status,
      images: 解析交付图片(order),
      text: order.delivery_text || '',
      deliveredAt: order.delivered_at,
      serviceTypeLabel: order.service_type_label,
      artworkName: order.artwork_name || ''
    });
  }

  res.json({
    status: order.status,
    serviceTypeLabel: order.service_type_label
  });
});

// ==========================================
// 查询设备/微信账号可见的历史订单
// GET /api/client/device-orders/:uuid?openid=xxx
// ==========================================
router.get('/device-orders/:uuid', (req, res) => {
  const deviceUuid = req.params.uuid;
  const openid = String(req.query.openid || '').trim();
  if (!deviceUuid) {
    return res.status(400).json({ error: '缺少设备标识' });
  }

  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.page_size || '20', 10), 1), 50);
  const historyOnly = req.query.history_only === '1';
  const offset = (page - 1) * pageSize;
  const { whereClause, params } = 构建身份查询条件(deviceUuid, openid, historyOnly);

  const total = db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE ${whereClause}`).get(...params).count;
  const orders = db.prepare(`
    SELECT id, service_type, service_type_label, status, delivery_token, delivery_images, delivery_text, delivered_at, created_at, artwork_name, openid, device_uuid
    FROM orders
    WHERE ${whereClause}
    ORDER BY COALESCE(delivered_at, created_at) DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset).map(order => ({
    ...order,
    images: 解析交付图片(order),
    imageUrls: 解析交付图片(order).map(file => `${SERVER_BASE_URL}/deliveries/${file}`)
  }));

  res.json({
    orders,
    total,
    page,
    pageSize,
    hasMore: offset + orders.length < total,
    identityMode: openid ? 'wechat' : 'device'
  });
});

// ==========================================
// 标记为已查收（用户在 index 页加载了交付图）
// POST /api/client/mark-viewed/:orderId
// ==========================================
router.post('/mark-viewed/:orderId', express.json(), (req, res) => {
  const order = db.prepare('SELECT id, status, device_uuid FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  if (order.status === 'delivered') {
    db.prepare("UPDATE orders SET status = 'viewed', viewed_at = datetime('now','localtime') WHERE id = ?").run(req.params.orderId);
  }

  记录订单埋点({
    orderId: req.params.orderId,
    deviceUuid: (req.body && req.body.device_uuid) || order.device_uuid || null,
    eventType: 'result_view',
    pageName: 'result',
    payload: { source: 'mark_viewed' }
  });

  res.json({ success: true });
});

// ==========================================
// 标记为已下载（用户长按保存了图片）
// POST /api/client/mark-downloaded/:orderId
// ==========================================
router.post('/mark-downloaded/:orderId', express.json(), (req, res) => {
  const order = db.prepare('SELECT id, status, device_uuid FROM orders WHERE id = ?').get(req.params.orderId);
  if (!order) return res.status(404).json({ error: '订单不存在' });

  if (['delivered', 'viewed'].includes(order.status)) {
    db.prepare("UPDATE orders SET status = 'downloaded', downloaded_at = datetime('now','localtime') WHERE id = ?").run(req.params.orderId);
  }

  记录订单埋点({
    orderId: req.params.orderId,
    deviceUuid: (req.body && req.body.device_uuid) || order.device_uuid || null,
    eventType: 'image_download',
    imageIndex: Number.isFinite(Number(req.body && req.body.image_index)) ? Number(req.body.image_index) : null,
    imageUrl: (req.body && req.body.image_url) || null,
    pageName: (req.body && req.body.page_name) || 'result',
    payload: { source: 'mark_downloaded' }
  });

  res.json({ success: true });
});

// ==========================================
// 获取预设作品列表（拍卖版专用）
// GET /api/client/artworks
// ==========================================
router.get('/artworks', (req, res) => {
  try {
    const keyword = String(req.query.q || '').trim().toLowerCase();
    let artworks = 读取作品列表();

    if (keyword) {
      artworks = artworks.filter(item => [item.num, item.id, item.name, item.author, item.medium, item.size]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword));
    }

    res.json({ artworks });
  } catch (e) {
    res.status(500).json({ error: '作品列表加载失败' });
  }
});

router.get('/artworks/resolve', (req, res) => {
  try {
    const artwork = 匹配作品(req.query.code || '');
    if (!artwork) {
      return res.status(404).json({ error: '未找到对应作品' });
    }
    res.json({ artwork });
  } catch (e) {
    res.status(500).json({ error: '作品识别失败' });
  }
});

router.post('/order-events', express.json(), (req, res) => {
  const { order_id, event_type, device_uuid, image_index, image_url, page_name, stay_ms, entered_at, left_at, ...payload } = req.body || {};
  if (!order_id || !event_type) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const order = db.prepare('SELECT id, device_uuid FROM orders WHERE id = ?').get(order_id);
  if (!order) {
    return res.status(404).json({ error: '订单不存在' });
  }

  记录订单埋点({
    orderId: order_id,
    deviceUuid: device_uuid || order.device_uuid || null,
    eventType: event_type,
    imageIndex: Number.isFinite(Number(image_index)) ? Number(image_index) : null,
    imageUrl: image_url || null,
    pageName: page_name || null,
    stayMs: Number.isFinite(Number(stay_ms)) ? Number(stay_ms) : null,
    enteredAt: entered_at || null,
    leftAt: left_at || null,
    payload
  });

  res.json({ success: true });
});

module.exports = router;
