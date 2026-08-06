// services/autodl.js —— AutoDL Pro 实例生命周期管理
//
// 适配 AutoDL 容器实例 Pro API：
// POST https://api.autodl.com/api/v1/dev/instance/pro/list
//
// 注意：
// - Authorization 默认直接使用原始 token，不自动加 Bearer。
// - 如你的 token 需要 Bearer，可设置 AUTODL_AUTH_PREFIX=Bearer。
// - Pro 镜像内密钥由 /etc/molink/gpu.env 管理，业务端开机命令不要传密钥。

const AUTODL_ENABLED = process.env.AUTODL_ENABLED !== '0';
const AUTODL_MODE = process.env.AUTODL_MODE || 'pro';

const AUTODL_BASE = (
  process.env.AUTODL_API_BASE ||
  (AUTODL_MODE === 'pro' ? 'https://api.autodl.com' : 'https://www.autodl.com/api/v1')
).replace(/\/+$/, '');

const AUTODL_TOKEN = process.env.AUTODL_TOKEN || '';
const AUTODL_AUTH_PREFIX = process.env.AUTODL_AUTH_PREFIX || '';

const PATH_LIST = process.env.AUTODL_PATH_LIST ||
  (AUTODL_MODE === 'pro' ? '/api/v1/dev/instance/pro/list' : '/instance');

const PATH_START = process.env.AUTODL_PATH_START ||
  (AUTODL_MODE === 'pro' ? '/api/v1/dev/instance/pro/power_on' : '/instance/restart');

const PATH_STOP = process.env.AUTODL_PATH_STOP ||
  (AUTODL_MODE === 'pro' ? '/api/v1/dev/instance/pro/power_off' : '/instance/shutdown');

const LIST_METHOD = (process.env.AUTODL_PRO_LIST_METHOD || (AUTODL_MODE === 'pro' ? 'POST' : 'GET')).toUpperCase();

const UUID_FIELD = process.env.AUTODL_PRO_UUID_FIELD || 'instance_uuid';
const START_COMMAND_FIELD = process.env.AUTODL_PRO_START_COMMAND_FIELD || 'start_command';
const FORCE_POWER_ON_WITHOUT_WORKER = process.env.AUTODL_FORCE_POWER_ON_WITHOUT_WORKER !== '0';

let lastTargetInstanceId = '';

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[autodl] ${name} 不是合法 JSON，使用默认值: ${error.message}`);
    return fallback;
  }
}

function authHeaderValue() {
  if (!AUTODL_AUTH_PREFIX) return AUTODL_TOKEN;
  return `${AUTODL_AUTH_PREFIX} ${AUTODL_TOKEN}`;
}

function buildPreferredInstances() {
  // Pro 模式只允许使用 Pro 实例 ID。
  // 禁止旧普通实例变量混入 Pro API 调度。
  if (AUTODL_MODE === 'pro') {
    const proId = String(process.env.AUTODL_PRO_INSTANCE_ID || '').trim();

    return proId
      ? [{
          id: proId,
          gpu: process.env.AUTODL_PRO_GPU_LABEL || 'AutoDL Pro',
          priority: 0
        }]
      : [];
  }

  // 以下仅供旧普通实例模式保留。
  const items = [];

  if (process.env.AUTODL_INSTANCE_TITAN_XP) {
    items.push({
      id: process.env.AUTODL_INSTANCE_TITAN_XP,
      gpu: 'TITAN Xp',
      priority: 1
    });
  }

  if (process.env.AUTODL_INSTANCE_RTX2080TI) {
    items.push({
      id: process.env.AUTODL_INSTANCE_RTX2080TI,
      gpu: 'RTX 2080 Ti x2',
      priority: 2
    });
  }

  const csv = process.env.AUTODL_PREFERRED_INSTANCES || '';

  csv.split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .forEach((id, index) => {
      if (!items.some(item => item.id === id)) {
        items.push({
          id,
          gpu: `AutoDL ${index + 1}`,
          priority: 10 + index
        });
      }
    });

  return items.sort((a, b) => a.priority - b.priority);
}

const PREFERRED_INSTANCES = buildPreferredInstances();

function isConfigured() {
  return AUTODL_ENABLED && Boolean(AUTODL_TOKEN);
}

async function apiCall(method, urlPath, body) {
  if (!AUTODL_TOKEN) throw new Error('AUTODL_TOKEN 未配置');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.AUTODL_TIMEOUT_MS || 20000));

  try {
    const options = {
      method,
      headers: {
        Authorization: authHeaderValue(),
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const url = `${AUTODL_BASE}${urlPath}`;
    const r = await fetch(url, options);

    const text = await r.text().catch(() => '');
    let raw = {};
    try {
      raw = text ? JSON.parse(text) : {};
    } catch {
      raw = { text };
    }

    if (!r.ok) {
      throw new Error(`AutoDL API ${method} ${urlPath} → HTTP ${r.status}: ${text.slice(0, 300)}`);
    }

    if (raw && Object.prototype.hasOwnProperty.call(raw, 'code')) {
      const code = raw.code;
      const ok = code === 0 ||
        code === 200 ||
        String(code).toLowerCase() === 'success' ||
        String(code) === '0';

      if (!ok) {
        throw new Error(`AutoDL API ${method} ${urlPath} → code=${code}: ${raw.msg || raw.message || text.slice(0, 300)}`);
      }
    }

    return raw;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeInstanceList(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.data?.list)
      ? raw.data.list
      : Array.isArray(raw?.data?.items)
        ? raw.data.items
        : Array.isArray(raw?.list)
          ? raw.list
          : [];

  return list.map(item => ({
    uuid: String(item.uuid || item.instance_uuid || item.id || ''),
    machine_id: String(item.machine_id || ''),
    machine_alias: String(item.machine_alias || ''),
    region_sign: String(item.region_sign || ''),
    region_name: String(item.region_name || ''),
    status: String(item.status || item.status_info || item.state || '').toLowerCase(),
    sub_status: String(item.sub_status || ''),
    gpu_model: String(item.gpu_model || item.machine_alias || item.gpu_name || ''),
    raw: item
  })).filter(item => item.uuid);
}

async function listInstances() {
  const body = LIST_METHOD === 'GET'
    ? undefined
    : parseJsonEnv('AUTODL_PRO_LIST_BODY', {
        page_index: Number(process.env.AUTODL_PRO_PAGE_INDEX || 1),
        page_size: Number(process.env.AUTODL_PRO_PAGE_SIZE || 10)
      });

  const raw = await apiCall(LIST_METHOD, PATH_LIST, body);
  return normalizeInstanceList(raw);
}

function pickPreferredInstance(instances = []) {
  if (AUTODL_MODE === 'pro') {
    const proId = String(process.env.AUTODL_PRO_INSTANCE_ID || '').trim();

    // 手工指定 Pro ID 时，必须在 Pro API 列表中真实存在。
    if (proId) {
      const found = instances.find(item => item.uuid === proId);

      if (!found) {
        throw new Error(
          `AUTODL_PRO_INSTANCE_ID=${proId} 不在 pro/list 返回结果中；拒绝调用 power_on。`
        );
      }

      return {
        ...found,
        gpu: process.env.AUTODL_PRO_GPU_LABEL || found.gpu_model || 'AutoDL Pro'
      };
    }

    // 没有指定 ID，且账号只有一台 Pro 时，安全地自动选择它。
    if (instances.length === 1) {
      return {
        ...instances[0],
        gpu: instances[0].gpu_model || 'AutoDL Pro'
      };
    }

    // 多台 Pro 时绝不猜测，要求显式指定。
    if (instances.length > 1) {
      throw new Error(
        `检测到 ${instances.length} 台 Pro 实例，请配置 AUTODL_PRO_INSTANCE_ID。`
      );
    }

    return null;
  }

  // 普通实例旧逻辑，仅非 Pro 模式使用。
  for (const pref of PREFERRED_INSTANCES) {
    const found = instances.find(item => item.uuid === pref.id);
    if (found) {
      return { ...found, gpu: pref.gpu };
    }
  }

  return PREFERRED_INSTANCES.length
    ? {
        uuid: PREFERRED_INSTANCES[0].id,
        status: 'unknown',
        gpu: PREFERRED_INSTANCES[0].gpu
      }
    : (instances[0] || null);
}

function buildStartBody(uuid) {
  const body = parseJsonEnv('AUTODL_PRO_START_BODY', {});
  body[UUID_FIELD] = uuid;

  const command = process.env.AUTODL_PRO_START_COMMAND || process.env.AUTODL_START_COMMAND || '';
  if (command) {
    body[START_COMMAND_FIELD] = command;
  }

  const payload = process.env.AUTODL_PRO_START_PAYLOAD || process.env.AUTODL_START_PAYLOAD || '';
  if (payload) {
    body.payload = payload;
  }

  Object.assign(body, parseJsonEnv('AUTODL_PRO_START_BODY_EXTRA', {}));
  return body;
}

function buildStopBody(uuid) {
  const body = parseJsonEnv('AUTODL_PRO_STOP_BODY', {});
  body[UUID_FIELD] = uuid;
  Object.assign(body, parseJsonEnv('AUTODL_PRO_STOP_BODY_EXTRA', {}));
  return body;
}

async function startInstance(uuid) {
  if (!uuid) {
    throw new Error('startInstance 缺少 uuid');
  }

  if (AUTODL_MODE === 'pro') {
    const actualProInstances = await listInstances();

    const exists = actualProInstances.some(item => item.uuid === uuid);

    if (!exists) {
      throw new Error(
        `拒绝启动不存在于当前 pro/list 的实例：${uuid}`
      );
    }
  }

  lastTargetInstanceId = uuid;

  const body = AUTODL_MODE === 'pro'
    ? buildStartBody(uuid)
    : { instance_uuid: uuid };

  console.log(
    `[autodl] power_on target=${uuid}, command=${body[START_COMMAND_FIELD] ? 'yes' : 'no'}`
  );
  return apiCall('POST', PATH_START, body);
}

async function stopInstance(uuid) {
  if (!uuid) throw new Error('stopInstance 缺少 uuid');

  const body = AUTODL_MODE === 'pro'
    ? buildStopBody(uuid)
    : { instance_uuid: uuid };

  console.log(`[autodl] power_off target=${uuid}`);
  return apiCall('POST', PATH_STOP, body);
}

async function getInstanceStatus(uuid) {
  const list = await listInstances();
  const found = list.find(i => i.uuid === uuid);
  return found || null;
}

function getLastTargetInstanceId() {
  return lastTargetInstanceId ||
    process.env.AUTODL_PRO_INSTANCE_ID ||
    process.env.AUTODL_INSTANCE_ID ||
    process.env.AUTODL_INSTANCE_TITAN_XP ||
    process.env.AUTODL_INSTANCE_RTX2080TI ||
    '';
}

// 收到作业时调用：优先复用已连接的空闲 worker，否则按优先级开机
async function selectAndStartInstance(workerHub) {
  const idle = workerHub && typeof workerHub.getIdleWorker === 'function'
    ? workerHub.getIdleWorker()
    : null;

  if (idle) {
    return { action: 'reuse', instance_id: idle.instance_id, gpu: idle.gpu_model };
  }

  const hasAnyWorker = workerHub && typeof workerHub.hasAnyWorker === 'function'
    ? workerHub.hasAnyWorker()
    : false;

  if (!isConfigured()) {
    return hasAnyWorker
      ? { action: 'queued_busy', reason: 'worker_busy_autodl_not_configured' }
      : { action: 'not_configured' };
  }

  let instances = [];
  try {
    instances = await listInstances();
  } catch (err) {
    console.warn('[autodl] listInstances 失败:', err.message);
  }

  const target = pickPreferredInstance(instances);
  if (!target || !target.uuid) {
    return hasAnyWorker
      ? { action: 'queued_busy', reason: 'worker_busy_no_extra_instance' }
      : { action: 'none_available' };
  }

  lastTargetInstanceId = target.uuid;

  const status = String(target.status || '').toLowerCase();
  if (status === 'running' || status === 'starting' || status === 'booting') {
    // AutoDL Pro 在 power_off 后可能短时间仍返回 running/starting。
    // 没有任何 worker 反连时，只返回 starting 会让队列持续等待。
    // 这里补发一次 power_on/start_command，让已关机或卡在启动态的实例恢复拉起 worker。
    if (!hasAnyWorker && FORCE_POWER_ON_WITHOUT_WORKER) {
      try {
        await startInstance(target.uuid);
        return { action: 'start_command_replayed', previous_status: status, instance_id: target.uuid, gpu: target.gpu || target.gpu_model };
      } catch (err) {
        console.warn(`[autodl] 补发 power_on/start_command 失败，继续等待 worker 反连: ${err.message}`);
      }
    }

    return { action: 'starting', instance_id: target.uuid, gpu: target.gpu || target.gpu_model, status };
  }

  try {
    await startInstance(target.uuid);
    return { action: 'started', instance_id: target.uuid, gpu: target.gpu || target.gpu_model };
  } catch (err) {
    console.warn(`[autodl] 启动 Pro 实例 ${target.uuid} 失败:`, err.message);
    return { action: 'none_available', error: err.message };
  }
}

module.exports = {
  isConfigured,
  listInstances,
  pickPreferredInstance,
  getInstanceStatus,
  startInstance,
  stopInstance,
  selectAndStartInstance,
  getLastTargetInstanceId,
  PREFERRED_INSTANCES
};
