const SERVER_BASE_URL = 'https://www.molink.art';

const MATCH_RULES_TEXT = `请将这件作品放到这个家装空间内，按照作品特点和匹配规则完成生成。空间内不要增减家具，去除原有的挂画和明显杂物，保留文玩摆件，可以转动视角寻找更优的悬挂位置。调整画面明度使其与环境合理自然且一致。最重要的是严格遵循我提供的画作尺寸信息。
作品信息，应在空间设计中作为整体视觉及家具设计的部分充分参考：

作品与空间陈设匹配规则，自行判断哪些规则是当前设计所需的：
如果空间使用对比鲜明的色彩打造引人入胜、充满活力的设计，为了达到最佳视觉效果，为墙面艺术品选择的主色调最好也出现在地毯或椅子上，均匀地分布在整个房间中，但不要直接使用艺术品上的图案，应对艺术品中的个别元素进行提取与抽象。选择一种中性色，例如白色或灰色，与你从色轮上选出的两种对比色相协调。这种颜色能使房间整体风格更加平衡。
如果空间色调单一，可以采用小面积的带有补色的挂画，为空间增添活力。
将同一位艺术家的多件作品，或风格语汇极为相似的作品组合在一起，能产生更强的视觉冲击力。
选取能表达房屋所处的特殊气候或周围环境的具象作品，产生外部空间的关联；让抱枕的花纹与作品保持相似，但内容风格又有差异，各有体系，以产生内部空间的关联。如地处威尼斯的空间搭配擅长描绘威尼斯生活的艺术家的作品，并让抱枕的色彩和纹路高度吻合画作上的斜向光影。
在统一作品与空间风格和色调的同时，选取能表达房屋所处的特殊气候或周围环境的具象作品。如轻盈、简约的灰白色调现代风格搭配白雪皑皑的山地景观作品。
抽象艺术几乎可以与任何室内装潢风格相匹配，但不要同时摆放过多装饰品，只选择那些更加能衬托艺术品的必需品。
形式单纯的抽象艺术更适合与室内空间中大体量家具的形式相匹配，如平行排列性的画作笔触与沙发的纹理产生自上而下的连续绵延的平行排列形式。
装饰品与艺术品的纹理、形状元素或色彩搭配保持一致，产生异质同构的效果，并在相对位置上营造出一种引导视线的韵律感。深色的墙面比浅白色更适合承载深色、高饱和、高对比度的作品。
确保作品的视觉张力能够支撑空间的视觉张力，包括环境光线、色彩和形式变化营造的视知觉体验。色彩越鲜艳，艺术品就需要越多的视觉空间。大尺幅作品比小尺幅提供更强的视觉张力，但通常看上去不会大于邻近的最大家具。而尺寸较小的艺术品则更适合较小的空间和邻近家具。
艺术作品的配色如果与环境中的家具不同，图形元素的相同能够带来更有趣活泼的视觉联系。
图形元素的相同能够带来更有趣活泼的视觉联系。
画作反映的质感可以与环境中的家具相关，如在棱角分明方体组成的沙发和不锈钢管线条结构的桌椅旁安置描绘北方金属外皮的工业建筑的画作。
艺术作品可以成为关联两种弱相关环境元素的中间媒介，如使用藤曼般蜿蜒的轮胎痕壁画来串联落地窗后葱郁的热带自然景观和带有工业特质的现代主义设计，以背后的“橡胶”意象串联起完整的空间叙事。
作品与家具设计的流派和文化来源一致通常有较好的效果。
运用灰色和棕色为主的中性色调使多元的古典风格和不同年代的新旧物品浑然一体，散发出历史的厚重和温馨的气息。
画框、装饰条和线条之间要留出足够的空间，让空间显得更宽敞。确保每件艺术品与其他作品保持等距，每件墙面艺术品之间以及画框四周都应留出 3-6 英寸的距离。较大的艺术品画框之间应留出更多空间，较小的艺术品则应集中摆放。
从地面到作品水平中心应在60英寸（152厘米）左右，随居住者平均身高上下浮动。如果作品在餐桌旁边且远离过道，则应适当下降在135cm左右，以适应人体坐高。
如作品安置在边柜或沙发上方墙面，其宽度应为下方家具的三分之二倍至0.618倍，具体大小取决于两者视觉体量的平衡与其他视觉张力因素。

画框与装裱效果生成规则：
当作品为宋元代中国画时，画框和装裱起到衔接画面颜色与墙面家具颜色的作用，并衬托作品气质。画框内层卡纸、衬纸在明亮空间中常用纯白起提亮作用，但如果空间中亮白色少，应跟随暗淡的画面与墙面色调选用相近的浅驼、淡灰或浅豆青等素色避免夺目。画面内容气质清雅的应简洁明快，内容华丽饱满的则使用复杂质感的配框与有色织锦内衬。如果画面多留白淡雅，框色用相近明度的柚木色至胡桃色，如果画面墨色重对比强，可以用深檀色至黑色边框，画框颜色最好与空间中家具存在相同。家具设计偏轻盈则画框也应轻薄纤细，家具厚实则适当加宽，保持平衡，可以使用极细金属色边线呼应空间中的金属材质。简洁利落或中古家具风格适合搭配哑光细黑画框，只含画芯画框，不使用卡纸留白，视觉干净清爽，但团扇作品一定使用卡纸留白、方形画框装裱，不要使用圆形画框。偏传统中式风格家具适合挂轴形制的立轴类型作品，绫色低饱和需与作品或空间中的低饱和色彩呼应，但与墙面颜色不同，轴杆颜色呼应空间里的深木色或金属色。现代风格或中古风家具适合装框立轴作品，简洁清爽。一件画作的挂轴或画框只能选择其中一种使用，不能叠加使用。
当挂画为现代中式风格时，使用画框装裱不要出现白边。`;

function safeJsonParse(value, fallback) {
  if (value == null || value === '') return fallback;
  if (Array.isArray(fallback) && Array.isArray(value)) return value;
  if (!Array.isArray(fallback) && typeof fallback === 'object' && fallback && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch (error) {
    return fallback;
  }
}

function toAbsoluteFileUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/uploads/')) return `${SERVER_BASE_URL}${text}`;
  if (text.startsWith('uploads/')) return `${SERVER_BASE_URL}/${text}`;
  return `${SERVER_BASE_URL}/uploads/${text}`;
}

function getArtworkSizeText(artwork) {
  return String(artwork?.size_text || artwork?.size || artwork?.artwork_size || '').trim();
}

function getArtworkPrimaryImage(artwork) {
  return String(
    artwork?.primary_image_url
    || artwork?.cover_url
    || artwork?.image_url
    || artwork?.full_url
    || (Array.isArray(artwork?.images) ? artwork.images[0] : '')
    || ''
  ).trim();
}

function getArtworkThumbnailImage(artwork) {
  return String(
    artwork?.thumb_url
    || artwork?.primary_thumb_url
    || artwork?.cover_thumb_url
    || artwork?.image_url
    || artwork?.primary_image_url
    || artwork?.cover_url
    || ''
  ).trim();
}

function buildRecommendedArtworkSnapshot(artwork) {
  return {
    id: artwork?.id || null,
    artwork_code: artwork?.artwork_code || artwork?.code || artwork?.num || null,
    name: artwork?.name || '',
    author: artwork?.author || '',
    size_text: getArtworkSizeText(artwork),
    image_url: getArtworkPrimaryImage(artwork),
    thumb_url: getArtworkThumbnailImage(artwork),
    full_url: getArtworkPrimaryImage(artwork)
  };
}

function buildRecommendWorkUserMessage({ spaceUrl, artwork, notes = '' }) {
  const snapshot = buildRecommendedArtworkSnapshot(artwork);
  const sizeText = snapshot.size_text || '尺寸未提供';
  const notePrefix = notes ? `用户备注：${notes}。请在生成时参考。\n` : '';
  return [
    { text: `${notePrefix}请将这件作品放到该空间中。作品名称：${snapshot.name || '未命名作品'}。作者：${snapshot.author || '未知作者'}。尺寸：${sizeText}。请严格使用这件作品原图，不要替换成其他作品。` },
    { file_url: snapshot.image_url },
    { text: '目标空间如下：' },
    { file_url: spaceUrl },
    { text: MATCH_RULES_TEXT + `\n\n本次必须使用的作品名称：${snapshot.name || '未命名作品'}。作者：${snapshot.author || '未知作者'}。尺寸：${sizeText}。` }
  ];
}

function buildGenerationPlanItem({ execId, artwork, userMessage }) {
  const snapshot = buildRecommendedArtworkSnapshot(artwork);
  return {
    exec_id: execId,
    artwork_id: snapshot.id,
    artwork_code: snapshot.artwork_code,
    artwork_name: snapshot.name,
    artwork_author: snapshot.author,
    artwork_size: snapshot.size_text,
    artwork_image_url: snapshot.image_url,
    user_message: userMessage
  };
}

function buildAiResultRecord(url, planItem) {
  return {
    url,
    exec_id: planItem?.exec_id || null,
    artwork_id: planItem?.artwork_id || null,
    artwork_code: planItem?.artwork_code || null,
    artwork_name: planItem?.artwork_name || '',
    artwork_author: planItem?.artwork_author || '',
    artwork_size: planItem?.artwork_size || ''
  };
}

module.exports = {
  SERVER_BASE_URL,
  safeJsonParse,
  toAbsoluteFileUrl,
  getArtworkSizeText,
  getArtworkPrimaryImage,
  getArtworkThumbnailImage,
  buildRecommendedArtworkSnapshot,
  buildRecommendWorkUserMessage,
  buildGenerationPlanItem,
  buildAiResultRecord
};
