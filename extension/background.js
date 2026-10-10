/* 代理执行器 —— 零配置哑执行器（MV3）
 *
 * 设计原则：这里不存任何业务配置、不提供任何界面。
 * 一切都由油猴脚本通过消息下发：apiUrl / scheme / 账密 / 心跳超时。
 * 之所以必须是扩展：只有扩展能调用 chrome.proxy.settings.set() 改浏览器代理。
 */

const DEFAULTS = {
  enabled: false,
  currentIp: '', currentPort: 0, updatedAt: 0,
  apiUrl: '', scheme: 'http', username: '', password: '',
  lastBeatAt: 0, beatCount: 0, rotateCount: 0,
  autoStopSec: 300, ttlSec: 300, minGapMs: 1500, settleMs: 400,
  lastRotateAt: 0, stoppedByWatchdog: false,
  lastError: '', lastRaw: '',
  maxRetry: 3, slowMs: 3000, probeUrl: '', lastProbeMs: 0, lastProbeOk: false,
  DEFAULT_PROBE: ''
};

/* 出口探测用的轻量地址：越小越快越稳越好。
 * 默认用国内可达的静态资源，避免因探测站点本身慢而误判代理不可用。
 * 可在脚本「代理配置」页里改成任意你觉得合适的地址。 */
const DEFAULT_PROBE_URL = 'https://www.baidu.com/favicon.ico';

const getCfg = () => new Promise((r) => chrome.storage.local.get(DEFAULTS, r));
const setCfg = (o) => new Promise((r) => chrome.storage.local.set(o, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastErr() {
  try {
    const e = chrome.runtime && chrome.runtime.lastError;
    return e ? String(e.message || e) : '';
  } catch (e) { return ''; }
}

/* 提取 API 必须直连：否则提取请求自己走代理出去，出口 IP 变了会被服务商拒绝 */
function apiHostOf(u) {
  try { return new URL(String(u)).hostname || ''; } catch (e) { return ''; }
}
function buildBypass(cfg) {
  const list = ['localhost', '127.0.0.1', '<local>'];
  const h = apiHostOf(cfg.apiUrl);
  if (h) list.push(h, '*' + h);
  /* 脚本下发的必须直连的域名（任务平台等）：这些请求也走浏览器网络栈，
   * 一旦走代理 IP 就会超时/被拒，表现为"网络错误"。 */
  const extra = Array.isArray(cfg.bypassHosts) ? cfg.bypassHosts : [];
  for (const d of extra) {
    const x = String(d || '').trim();
    if (!x) continue;
    list.push(x, '*' + x);
  }
  return Array.from(new Set(list));
}

function parseProxy(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('API 返回为空');

  /* 兜底：判断一个 token 是否长得像"另一个主机/记录"（多记录粘连的残留），
   * 是的话说明它不是账密，应当丢弃。 */
  const looksLikeHost = (t) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(t) || /[:@]/.test(t);

  if (text[0] === '{' || text[0] === '[') {
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* 走文本解析 */ }
    if (j) {
      const arr = j.obj || j.RESULT || j.result || j.data || j.list || (Array.isArray(j) ? j : null);
      if (Array.isArray(arr) && arr.length) {
        const o = arr[0];
        const ip = o.ip || o.host || o.proxyIp;
        const port = o.port || o.proxyPort;
        if (ip && port) {
          return { ip, port: parseInt(port, 10), username: o.account || o.username || '', password: o.password || '' };
        }
      }
      if (j.code !== undefined && String(j.code) !== '0' && !arr) {
        throw new Error('API 返回错误：' + text.slice(0, 200));
      }
    }
  }

  /* 取第一条记录：先按换行切，再按逗号切（部分服务商用逗号分隔多条，如快代理 sep=2），
   * 否则第二条记录会被误当成账号密码。 */
  const line = (text.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean)[0] || '')
    .split(',')[0].trim();

  /* 写法四：账号:密码@主机:端口 —— IPFoxy 这类"固定入口 + 账密内嵌在 URL 里"的格式
   *   例：customer-0hvAdSkrVu-cc-HK-st-Kowlooncity:Bt0AA3dy6ztsm6P@gate.ipfoxy.io:58688
   * 特点：主机是【域名】而不是 IP，所以必须放在 IP 分支之前判断。
   * 用 lastIndexOf('@') 切：host:port 里不会含 @，即使密码里含 @ 也能正确切分。
   * 返回的 ip 字段这里其实是主机（域名或 IP），applyProxy 对两者都支持。 */
  {
    // 先整体剥掉协议前缀，否则 "http://u:p@host:port" 会把 "http" 当成账号
    const clean = line.replace(/^https?:\/\//i, '');
    const at = clean.lastIndexOf('@');
    if (at > 0) {
      const cred = clean.slice(0, at).trim();
      const hp = clean.slice(at + 1).trim();
      const ci = cred.indexOf(':');
      const pi = hp.lastIndexOf(':');
      if (ci > 0 && pi > 0) {
        const host = hp.slice(0, pi).trim();
        const port = parseInt(String(hp.slice(pi + 1)).match(/^\d+/)?.[0] || '0', 10);
        if (host && port > 0 && port < 65536) {
          return {
            ip: host, port,
            username: cred.slice(0, ci).trim(),
            password: cred.slice(ci + 1).trim()
          };
        }
      }
    }
  }

  /* 写法五：主机:端口:账号:密码 —— 快代理 generateType=1 的真实返回
   *   例：u125.kdltpspro.com:15818:t19005550060912:3u5btcqa
   * 关键：主机是【域名】不是 IP，所以必须放在下面 IP 分支之前判断，
   * 否则会被 "提取失败" 直接拦掉。
   * 主机既可以是域名也可以是 IP（熊猫的 ip:port:账号:Password 同样走这里）。
   * 密码里若含冒号，用 slice(3).join(':') 保留完整。
   * 兼容全角冒号。 */
  {
    const seg = line.split(/[:：]/);
    if (seg.length >= 4) {
      const host = String(seg[0]).trim();
      const port = parseInt(String(seg[1]).trim(), 10);
      const user = String(seg[2]).trim();
      const pass = seg.slice(3).join(':').trim();
      // 主机里不能含 @（那是写法四），端口必须是合法数字
      if (host && !/[@\s]/.test(host) && port > 0 && port < 65536 && user && pass) {
        return { ip: host, port, username: user, password: pass };
      }
    }
  }

  /* 写法六：主机:端口（可带账密）—— 主机可以是【域名】也可以是 IP
   *   例：u125.kdltpspro.com:15818            ← 快代理不带 generateType 时返回
   *   例：u125.kdltpspro.com:15818 账号 密码
   *   例：1.2.3.4:8080 / 1.2.3.4:8080 账号 密码
   * 必须是"两段"结构（只有一个冒号）：第一段是主机，第二段以端口开头；
   * 端口之后的剩余部分若有，按空格/冒号切成账号密码。
   * 这样"域名主机"就不会再被下面的 IP 正则误判为提取失败。 */
  {
    const seg = line.split(/[:：]/);
    if (seg.length === 2) {
      const host = String(seg[0]).trim();
      const pm = String(seg[1]).trim().match(/^(\d{2,5})(.*)$/);
      if (host && pm && /^[A-Za-z0-9._\-]+$/.test(host)) {
        const port = parseInt(pm[1], 10);
        if (port > 0 && port < 65536) {
          let username = '', password = '';
          const tail = String(pm[2] || '').trim();
          if (tail) {
            const parts = tail.split(/[\s:：]+/).filter(Boolean);
            const u = parts[0] || '';
            const pw = parts[1] || '';
            // 残段长得像另一个主机（多记录粘连）就不是账密，丢弃
            if (!looksLikeHost(u) && !looksLikeHost(pw)) {
              username = u; password = pw;
            }
          }
          return { ip: host, port, username, password };
        }
      }
    }
  }

  if (!/\d{1,3}(\.\d{1,3}){3}/.test(line)) throw new Error('提取失败，API 返回：' + text.slice(0, 200));

  /* 支持另外两种写法（分隔符可以是空格、制表符）：
   *   ip:port
   *   ip:port 账号 密码     ← returnAccount 开启时的常见格式，如
   *                          "58.220.27.167:59062 xmdl5857 xmdl54ab"
   * 先抠出 ip:port，再把剩下的部分切成 token，取前两个当账号和密码。 */
  const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3})\s*[:：]\s*(\d{2,5})(.*)$/);
  if (!m) throw new Error('无法解析，API 返回：' + text.slice(0, 200));

  const rest = String(m[3] || '').trim();
  let username = '', password = '';
  if (rest) {
    const parts = rest.split(/[\s:：]+/).filter(Boolean);
    const u = parts[0] || '';
    const p = parts[1] || '';
    if (!looksLikeHost(u) && !looksLikeHost(p)) {
      username = u;
      password = p;
    }
  }
  return { ip: m[1], port: parseInt(m[2], 10), username, password };
}

function applyProxy(host, port, cfg) {
  const value = {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: cfg.scheme || 'http', host: host, port: Number(port) },
      bypassList: buildBypass(cfg)
    }
  };
  return new Promise((r) => {
    chrome.proxy.settings.set({ value, scope: 'regular' }, () => {
      const e = lastErr();
      if (e) r({ ok: false, error: e }); else r({ ok: true });
    });
  });
}

const clearProxy = () => new Promise((r) => {
  chrome.proxy.settings.clear({ scope: 'regular' }, () => {
    const e = lastErr();
    if (e) r({ ok: false, error: e }); else r({ ok: true });
  });
});

/* ---------- 换 IP（串行化，防并发重复消耗额度） ---------- */
let _chain = Promise.resolve();
function serialize(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.then(() => {}, () => {});
  return run;
}

/* ---------- 出口可用性探测 ----------
 * 换完 IP 后主动打一次轻量请求，测出"能不能通 + 快不快"。
 * 只有真正可用且达标才认为这次切换合格，否则自动换下一个。 */
function probeOnce(url, timeoutMs) {
  const t0 = Date.now();
  let timer = null;
  let ctrl = null;
  try {
    ctrl = new AbortController();
    timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs);
  } catch (e) { /* 老环境没有 AbortController，退化成不中断 */ }
  const sep = String(url).includes('?') ? '&' : '?';
  return fetch(url + sep + '_p=' + Date.now(), {
    cache: 'no-store',
    mode: 'no-cors',
    signal: ctrl ? ctrl.signal : undefined
  }).then(() => {
    if (timer) clearTimeout(timer);
    return { ok: true, ms: Date.now() - t0 };
  }).catch((e) => {
    if (timer) clearTimeout(timer);
    const isAbort = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { ok: false, ms: Date.now() - t0, error: isAbort ? '超时' : String((e && e.message) || e) };
  });
}

async function doRotate(incoming) {
  // 脚本每次都把配置带过来，扩展本身不存业务配置
  const patch = {
    apiUrl: incoming.apiUrl || '',
    scheme: incoming.scheme || 'http',
    ttlSec: Number(incoming.ttlSec) || 300,
    minGapMs: Number(incoming.minGapMs) || 0,
    settleMs: Number(incoming.settleMs) || 0,
    autoStopSec: Number(incoming.autoStopSec) || 300,
    // 必须直连的域名（任务平台等）：要带进 cfg，buildBypass 才读得到
    bypassHosts: Array.isArray(incoming.bypassHosts) ? incoming.bypassHosts : []
  };
  const cfg = Object.assign(await getCfg(), patch);

  // 换 IP 后的可用性判定参数（脚本下发，页面可配）
  const maxTry = Math.max(1, Math.min(10, Number(incoming.maxRetry) || 3));
  const slowMs = Math.max(200, Number(incoming.slowMs) || 3000);
  const probeUrl = String(incoming.probeUrl || '').trim() || DEFAULT_PROBE_URL;
  const probeTimeout = Math.max(slowMs * 2, 5000);
  // 关闭判定：maxRetry=1 时仍要换 1 次；<=0 视作 1
  const wantProbe = incoming.probe !== false && probeUrl;

  if (!cfg.apiUrl) {
    await setCfg({ lastError: '脚本未提供 API 链接' });
    return { ok: false, error: '脚本未提供 API 链接', cfg: await getCfg() };
  }

  const doFetch = () => {
    const sep = cfg.apiUrl.includes('?') ? '&' : '?';
    return fetch(cfg.apiUrl + sep + '_t=' + Date.now(), { cache: 'no-store' }).then(r => r.text());
  };

  const reasons = [];        // 每次尝试失败的原因
  let used = 0;              // 实际提取次数（= 消耗额度）

  for (let attempt = 1; attempt <= maxTry; attempt++) {
    let p = null;
    // 失败发生在哪个阶段：fetch=提取接口 / apply=写入代理 / probe=出口探测
    let stage = 'fetch';
    try {
      /* --- 1) 提取 --- */
      // 防"提取过快"：两次提取之间保持最小间隔
      const gap = Date.now() - (cfg.lastRotateAt || 0);
      if (gap < (cfg.minGapMs || 0)) await sleep((cfg.minGapMs || 0) - gap);

      let raw = null;
      try {
        raw = await doFetch();
      } catch (e) {
        /* 若当前已挂着代理却提取失败（典型 "Failed to fetch"），
         * 很可能是旧代理已失效把网络搞死了 → 先恢复直连再试一次。 */
        const tail = '。请检查网络、提取链接是否有效，或本机公网 IP 是否在服务商白名单内';
        if (cfg.enabled) {
          await clearProxy();
          try {
            raw = await doFetch();
          } catch (e2) {
            throw new Error('提取失败（已恢复直连）：' + String((e2 && e2.message) || e2) + tail);
          }
        } else {
          throw new Error('提取失败：' + String((e && e.message) || e) + tail);
        }
      }
      used++;

      /* --- 2) 解析 + 写入 --- */
      stage = 'apply';
      p = parseProxy(raw);
      const now = Date.now();

      const applied = await applyProxy(p.ip, p.port, cfg);
      if (applied && applied.ok === false) throw new Error('写入代理失败：' + applied.error + '（可能被其他扩展或策略占用）');

      try {
        chrome.privacy.network.webRTCIPHandling.set({ value: 'disable_non_proxied_udp', scope: 'regular' }, () => {});
      } catch (e) { /* 部分平台不支持 */ }

      cfg.lastRotateAt = now;
      cfg.rotateCount = (cfg.rotateCount || 0) + 1;
      await setCfg(Object.assign({}, patch, {
        currentIp: p.ip, currentPort: p.port, updatedAt: now,
        lastRaw: String(raw).slice(0, 300), lastError: '',
        enabled: true,
        // 白名单模式强制不带账密；手动填写以脚本下发的为准；自动读取用 API 返回的
        username: incoming.noAuth ? '' : (incoming.username || p.username || ''),
        password: incoming.noAuth ? '' : (incoming.password || p.password || ''),
        lastBeatAt: now, lastRotateAt: now, stoppedByWatchdog: false,
        rotateCount: cfg.rotateCount,
        maxRetry: maxTry, slowMs: slowMs, probeUrl: probeUrl
      }));

      if (cfg.settleMs) await sleep(cfg.settleMs);

      /* --- 3) 判定：这个 IP 到底能不能用 --- */
      if (!wantProbe) {
        const same0 = !!(cfg.currentIp && cfg.currentIp === p.ip
          && cfg.currentPort === p.port && attempt === 1);
        return { ok: true, ip: p.ip, port: p.port, attempts: attempt, sameAsBefore: same0, cfg: await getCfg() };
      }
      stage = 'probe';
      const pr = await probeOnce(probeUrl, probeTimeout);
      if (pr.ok && pr.ms <= slowMs) {
        /* 诊断：若这次提取到的和当前正在用的完全一样，说明并没有真正换 IP。
         * 常见原因是提取过于频繁被服务商限流返回同一个，或链接没开去重。 */
        const same = !!(cfg.currentIp && cfg.currentIp === p.ip
          && cfg.currentPort === p.port && attempt === 1);
        await setCfg({ lastProbeMs: pr.ms, lastProbeOk: true });
        return {
          ok: true, ip: p.ip, port: p.port, attempts: attempt,
          probeMs: pr.ms, sameAsBefore: same, cfg: await getCfg()
        };
      }
      // 不合格：记录下来，换下一个
      reasons.push('第' + attempt + '次 ' + p.ip + ':' + p.port + ' → '
        + (pr.ok ? ('速度过慢 ' + pr.ms + 'ms（阈值 ' + slowMs + 'ms）') : ('不可用：' + pr.error)));
      await setCfg({ lastProbeMs: pr.ms, lastProbeOk: false });

      if (attempt >= maxTry) break;
      await clearProxy();          // 先清掉这个不达标的，避免残留影响下一次提取
    } catch (e) {
      const msg = String((e && e.message) || e);
      reasons.push('第' + attempt + '次 → ' + msg);
      await clearProxy();
      /* 提取接口本身拿不到 IP（链接失效/白名单没配/网络不通/被限流）时，
       * 换下一个 IP 也解决不了 —— 直接放弃，不再白白试满 maxRetry 次。
       * 只有"拿到了 IP 但不能用"（探测不合格/写入失败）才值得换下一个。 */
      if (stage === 'fetch') break;
      if (attempt >= maxTry) break;
    }
  }

  /* 全部尝试都不合格：必须恢复直连，否则浏览器会一直挂着死代理（表现=断网） */
  await clearProxy();
  const finalMsg = '已尝试 ' + used + ' 个 IP 均不可用，已恢复直连。' + reasons.join(' | ');
  await setCfg({
    lastError: finalMsg,
    enabled: false,
    currentIp: '',
    currentPort: 0,
    stoppedByWatchdog: false,   // 失败恢复，不触发 ping 自动接管
    lastProbeOk: false
  });
  return { ok: false, error: finalMsg, restored: true, attempts: used, cfg: await getCfg() };
}
/* 注意：不能写成 serialize(doRotate)，那样会把上一次 Promise 的结果当参数传进去 */
const rotate = (arg) => serialize(() => doRotate(arg));

async function disable(byWatchdog) {
  await clearProxy();
  await chrome.alarms.clear('watchdog');
  await setCfg({
    enabled: false, currentIp: '', currentPort: 0, lastBeatAt: 0,
    stoppedByWatchdog: !!byWatchdog
  });
}

/* 看门狗：脚本停止（无心跳）后自动恢复直连 */
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'watchdog') return;
  const cfg = await getCfg();
  if (!cfg.enabled) return;
  const t = Number(cfg.autoStopSec || 0);
  if (t > 0 && cfg.lastBeatAt && Date.now() - cfg.lastBeatAt > t * 1000) {
    await disable(true);
    await setCfg({ lastError: '脚本心跳超时 ' + t + ' 秒，已自动恢复直连' });
  }
});

/* 账密授权自动注入；白名单授权时脚本不下发账密，这里直接放行 */
chrome.webRequest.onAuthRequired.addListener(
  async (details, callback) => {
    if (!callback) return;
    const cfg = await getCfg();
    if (cfg.username) callback({ authCredentials: { username: cfg.username, password: cfg.password } });
    else callback({});
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

chrome.proxy.onProxyError.addListener((d) => setCfg({ lastError: '代理连接错误：' + (d.error || 'unknown') }));

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  (async () => {
    const t = msg && msg.type;
    if (t === 'rotate') {
      const r = await rotate(msg.payload || {});
      const cfg = await getCfg();
      if (cfg.enabled && Number(cfg.autoStopSec) > 0) chrome.alarms.create('watchdog', { periodInMinutes: 1 });
      sendResponse({
        ok: r.ok, ip: r.ip, port: r.port, error: r.error,
        restored: !!r.restored, attempts: r.attempts, probeMs: r.probeMs,
        sameAsBefore: !!r.sameAsBefore, cfg
      });
      return;
    }
    if (t === 'ping') {
      const cfg = await getCfg();
      await setCfg({ lastBeatAt: Date.now(), beatCount: (cfg.beatCount || 0) + 1 });
      let resumed = false;
      // 之前是被看门狗自动停的，现在脚本又报活 → 自动接管回来
      if (!cfg.enabled && cfg.stoppedByWatchdog && (cfg.apiUrl || (msg.payload || {}).apiUrl)) {
        const r = await rotate(msg.payload || {});
        resumed = !!(r && r.ok);
      }
      if (resumed || cfg.enabled) {
        const c2 = await getCfg();
        if (Number(c2.autoStopSec) > 0) chrome.alarms.create('watchdog', { periodInMinutes: 1 });
      }
      const out = await getCfg();
      out.resumed = resumed;
      sendResponse(out);
      return;
    }
    if (t === 'disable') {
      await disable(false);
      sendResponse(await getCfg());
      return;
    }
    if (t === 'status') {
      sendResponse(await getCfg());
      return;
    }
    sendResponse({ ok: false, error: 'unknown type' });
  })();
  return true;
});
