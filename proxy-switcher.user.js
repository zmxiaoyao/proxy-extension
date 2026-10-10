// ==UserScript==
// @name         代理 IP 切换器（纯换 IP）
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  浏览器出口 IP 切换工具：多服务商可选、换后自动判定可用性（不通/太慢自动换下一个）、一键改回直连。需配合「代理执行器」扩展使用。
// @author       Yuanbao
// @match        *://*/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ==========================================================================
     * 说明
     * --------------------------------------------------------------------------
     * 本脚本只负责：换 IP / 改回直连 / 查看当前 IP / 配置与日志。
     * 真正改浏览器代理的是配套扩展「代理执行器」——油猴改不了代理，
     * 必须通过 chrome.proxy API，那是扩展专属能力。
     * 两者用 window.postMessage 通信（油猴与扩展 content script 不在同一个
     * isolated world，但共享同一个底层 window）。
     *
     * 安装：
     *   1) Edge/Chrome → 扩展页 → 开发者模式 → 加载「代理执行器」文件夹
     *   2) Tampermonkey 装本脚本
     * ========================================================================== */

    const SETTINGS_KEY = 'proxy_switcher_settings';
    const CHECK_IP_URL = 'https://www.whatismyip.com.tw/';

    /* ============================================================
     * 服务商预设 —— 新增服务商只需在这里加一项，不用改别处。
     *
     *   key          唯一标识（下拉框 value）
     *   name         下拉框显示名
     *   url          【不预填】留空，避免把带 token 的私密链接写死在脚本里。
     *                链接请在「⚙ 配置」页粘贴，会自动持久化。
     *   sample       仅作输入框占位提示（展示格式），不会自动填充
     *   accountParam 链接里控制「是否随 IP 一并返回账号密码」的参数名；
     *                没有就留空 ''，此时切换认证方式【不会】去改链接
     *   accountOn    选「自动读取」时该参数应取的值
     *   accountOff   选「手动填写 / 白名单」时该参数应取的值
     *   note         返回格式说明（仅展示用）
     *
     * 支持的返回格式（扩展自动识别，无需在此配置）：
     *   ip:port
     *   ip:port 账号 密码
     *   主机:端口:账号:密码          ← 主机可以是域名（快代理 generateType=1）
     *   账号:密码@主机:端口          ← 主机可以是域名（IPFoxy）
     *   {"code":0,"obj":[{"ip":..,"port":..}]}
     * ============================================================ */
    const PROVIDERS = {
        xiongmao: {
            name: '熊猫代理',
            accountParam: 'returnAccount',
            accountOn: '2', accountOff: '0',
            url: '',
            sample: 'http://route.xiongmaodaili.com/xiongmao-web/sdApi/sdl?secret=xxx&orderNo=xxx&count=1&isTxt=1&proxyType=1&noTime=0&removal=0&returnAccount=2',
            note: '返回 ip:port，或 ip:port 账号 密码'
        },
        kuaidaili: {
            name: '快代理',
            accountParam: 'generateType',
            accountOn: '1', accountOff: '0',
            url: '',
            sample: 'https://tps.kdlapi.com/api/gettpspro/?secret_id=xxx&signature=xxx&num=1&format=text&sep=1&generateType=1',
            note: 'generateType=1 返回 主机:端口:账号:密码（主机多为域名）；不带则只返回 IP:Port'
        },
        thordata: {
            name: 'Thordata',
            accountParam: '', accountOn: '', accountOff: '',
            url: '',
            sample: 'https://get-ip.thordata.net/api?td-customer=xxx&sesstype=2&number=1&country=HK',
            note: '返回纯 ip:port（多为白名单授权，选「白名单」模式）'
        },
        ipfoxy: {
            name: 'IPFoxy',
            accountParam: '', accountOn: '', accountOff: '',
            url: '',
            sample: 'https://api.ipfoxy.com/ip/dynamic-api/ips?count=1&host=gate.ipfoxy.io&port=58688&type=txt&token=xxx&period=1',
            note: '返回 账号:密码@主机:端口（账密内嵌，选「账号密码 + 自动读取」）'
        },
        custom: {
            name: '自定义',
            accountParam: '', accountOn: '', accountOff: '',
            url: '', sample: '', note: ''
        }
    };

    /* ---------------- 默认配置 ---------------- */
    const DEFAULTS = {
        provider: 'xiongmao',
        apiUrl: '',              // 不预填，请在配置页粘贴
        authMode: 'password',    // whitelist | password
        accountSource: 'auto',   // auto | manual（authMode=password 时有效）
        username: '',
        password: '',
        scheme: 'http',
        ttlSec: 300,             // IP 有效期（秒），用于面板倒计时
        minGapMs: 3000,          // 两次提取的最小间隔，防"提取过快"
        settleMs: 500,           // 写入代理后的静置时间
        autoStopSec: 300,        // 心跳超时后自动恢复直连
        maxRetry: 3,             // 换到的 IP 不达标时最多再换几个
        slowMs: 3000,            // 响应超过此毫秒数算太慢
        probeUrl: '',            // 探测地址，留空用扩展默认
        autoRotate: false,       // 是否自动定时轮换
        rotateSec: 300           // 自动轮换间隔（秒）
    };

    let CFG = Object.assign({}, DEFAULTS);
    let bridgeReady = false;
    let beatTimer = null;
    let rotateTimer = null;
    let busy = false;
    const logs = [];

    /* ================= 持久化 ================= */
    function loadCfg() {
        try {
            const v = JSON.parse(GM_getValue(SETTINGS_KEY, 'null'));
            if (v && typeof v === 'object') {
                CFG = Object.assign({}, DEFAULTS, v);
                // 钳制，避免手改存档导致异常
                CFG.maxRetry = Math.max(1, Math.min(10, parseInt(CFG.maxRetry, 10) || 3));
                CFG.slowMs = Math.max(200, parseInt(CFG.slowMs, 10) || 3000);
                CFG.rotateSec = Math.max(30, parseInt(CFG.rotateSec, 10) || 300);
                if (CFG.authMode !== 'whitelist' && CFG.authMode !== 'password') CFG.authMode = 'password';
                if (CFG.accountSource !== 'auto' && CFG.accountSource !== 'manual') CFG.accountSource = 'auto';
                if (!PROVIDERS[CFG.provider]) CFG.provider = 'xiongmao';
            }
        } catch (e) { /* 用默认值 */ }
    }
    function saveCfg() {
        try { GM_setValue(SETTINGS_KEY, JSON.stringify(CFG)); } catch (e) {}
    }

    /* ================= 日志 ================= */
    const MAX_LOG = 300;
    function stamp() {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
    function addLog(msg) {
        const line = `[${stamp()}] ${msg}`;
        logs.push(line);
        if (logs.length > MAX_LOG) logs.shift();
        const box = document.getElementById('px-log');
        if (box) {
            const full = box.dataset.full === '1';
            box.textContent = full ? logs.join('\n') : logs.slice(-60).join('\n');
            box.scrollTop = box.scrollHeight;
        }
        console.log('[ProxySwitcher] ' + msg);
    }

    /* ================= 扩展通信 =================
     * 必须用 unsafeWindow 收发：脚本 @grant 非 none 时处于 sandbox，
     * 脚本里的 window 是包装过的代理对象，与扩展 content script 不互通；
     * unsafeWindow 才是真实页面 window。 */
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    function bridge(action, payload, timeoutMs) {
        return new Promise((resolve, reject) => {
            const id = 'px_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                W.removeEventListener('message', onMsg);
                reject(new Error('扩展无响应（超时）。请确认「代理执行器」已安装并已刷新本页面'));
            }, timeoutMs || 15000);

            function onMsg(ev) {
                const d = ev.data;
                if (!d || typeof d !== 'object' || d.__src !== 'MT_PROXY_EXT' || d.id !== id) return;
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                W.removeEventListener('message', onMsg);
                if (d.ok === false) reject(new Error(d.error || '未知错误'));
                else resolve(d.result || {});
            }

            W.addEventListener('message', onMsg);
            try {
                W.postMessage({ __src: 'MT_PROXY_BRIDGE', action: action, payload: payload || {}, id: id }, '*');
            } catch (e) {
                clearTimeout(timer);
                W.removeEventListener('message', onMsg);
                reject(e);
            }
        });
    }

    /* 只对幂等/只读动作重试，rotate 绝不重试（非幂等，会多消耗额度） */
    async function bridgeSafe(action, payload, timeoutMs) {
        for (let i = 0; i < 2; i++) {
            try { return await bridge(action, payload, timeoutMs); }
            catch (e) {
                if (i === 1) throw e;
                await new Promise(r => setTimeout(r, 300));
            }
        }
    }

    async function ensureBridge() {
        if (bridgeReady) return true;
        try {
            await bridgeSafe('status', {}, 3000);
            bridgeReady = true;
            return true;
        } catch (e) {
            addLog('⚠️ 未连上「代理执行器」扩展：' + e.message);
            return false;
        }
    }

    /* ================= 配置下发 ================= */
    function payloadBase() {
        const p = {
            apiUrl: String(CFG.apiUrl || '').trim(),
            scheme: CFG.scheme || 'http',
            ttlSec: Number(CFG.ttlSec) || 300,
            minGapMs: Number(CFG.minGapMs) || 0,
            settleMs: Number(CFG.settleMs) || 0,
            autoStopSec: Number(CFG.autoStopSec) || 300,
            maxRetry: CFG.maxRetry,
            slowMs: CFG.slowMs,
            probeUrl: String(CFG.probeUrl || '').trim()
        };
        if (CFG.authMode === 'whitelist') {
            p.noAuth = true;                     // 白名单：明确不带账密
        } else if (CFG.accountSource === 'manual') {
            p.username = CFG.username;           // 手动：用填的
            p.password = CFG.password;
        }
        // 自动读取：不下发账密，由扩展从 API 返回值里解析
        return p;
    }

    /* 改链接里某个 query 参数（不存在则追加） */
    function setUrlParam(url, key, value) {
        if (!key) return url;
        try {
            const i = url.indexOf('?');
            if (i < 0) return url + '?' + key + '=' + encodeURIComponent(value);
            const base = url.slice(0, i + 1);
            const pairs = url.slice(i + 1).split('&').filter(Boolean);
            let hit = false;
            const out = pairs.map(pair => {
                const eq = pair.indexOf('=');
                const k = eq < 0 ? pair : pair.slice(0, eq);
                if (k === key) { hit = true; return key + '=' + encodeURIComponent(value); }
                return pair;
            });
            if (!hit) out.push(key + '=' + encodeURIComponent(value));
            return base + out.join('&');
        } catch (e) { return url; }
    }
    function hasUrlParam(url, key) {
        if (!key) return false;
        try {
            const i = String(url).indexOf('?');
            if (i < 0) return false;
            return String(url).slice(i + 1).split('&').filter(Boolean).some(pair => {
                const eq = pair.indexOf('=');
                return (eq < 0 ? pair : pair.slice(0, eq)) === key;
            });
        } catch (e) { return false; }
    }

    /* 切换认证方式 / 账号来源时同步链接里的账密参数。
     * 关键：只在该参数【已存在】时才改，绝不凭空追加 ——
     * 换用其他服务商时链接里没有这个参数，追加一个它不认识的参数可能直接报错。
     * 「自动读取」本身也不依赖该参数：扩展总是会尝试从返回值解析账密。 */
    function syncAccountParam() {
        const prov = PROVIDERS[CFG.provider];
        if (!prov || !prov.accountParam) return false;
        if (!hasUrlParam(CFG.apiUrl, prov.accountParam)) return false;
        const want = (CFG.authMode === 'password' && CFG.accountSource === 'auto')
            ? (prov.accountOn || '1') : (prov.accountOff || '0');
        const next = setUrlParam(CFG.apiUrl, prov.accountParam, want);
        if (next !== CFG.apiUrl) { CFG.apiUrl = next; return true; }
        return false;
    }
    function accountParamState() {
        const prov = PROVIDERS[CFG.provider];
        if (!prov || !prov.accountParam) return 'na';
        return hasUrlParam(CFG.apiUrl, prov.accountParam) ? 'synced' : 'absent';
    }

    /* ================= 核心动作 ================= */

    /* 换 IP（含可用性判定：不通/太慢会自动换下一个，由扩展侧完成） */
    async function doRotate() {
        if (busy) { addLog('⏳ 正在切换中，请稍候'); return null; }
        if (!String(CFG.apiUrl || '').trim()) {
            addLog('⚠️ 请先在「⚙ 配置」里粘贴提取链接');
            return null;
        }
        busy = true;
        setBusy(true);
        try {
            if (!(await ensureBridge())) return null;
            addLog('🔄 正在切换 IP...');
            const r = await bridge('rotate', payloadBase(), 60000);
            if (!r || r.ok === false) throw new Error((r && r.error) || '未知错误');

            const cred = (r.cfg && r.cfg.username) ? `（认证：${r.cfg.username}）` : '（无账密，走白名单）';
            const spd = (r.probeMs != null) ? ` | 响应 ${r.probeMs}ms` : '';
            const att = (r.attempts && r.attempts > 1) ? `（第 ${r.attempts} 个才合格）` : '';
            addLog(`✅ 当前出口 → ${r.ip}:${r.port}${cred}${spd}${att} | 累计换 ${(r.cfg && r.cfg.rotateCount) || 0} 次`);
            if (r.sameAsBefore) {
                addLog('⚠️ 本次提取到的 IP 与上一个相同，可能并未真正更换（提取过快被限流时常见）');
            }
            startBeat();
            renderStatus(r.cfg);
            return r;
        } catch (e) {
            addLog('❌ 切换失败：' + e.message);
            stopBeat();
            renderStatus(null);
            return null;
        } finally {
            busy = false;
            setBusy(false);
        }
    }

    /* 改回直连：无条件清除代理 */
    async function doDirect() {
        try {
            stopBeat();
            stopAutoRotate();
            if (!(await ensureBridge())) return;
            await bridgeSafe('disable', {}, 10000);
            addLog('🔌 已改回直连（浏览器不再走代理）');
            renderStatus(null);
        } catch (e) {
            addLog('⚠️ 恢复直连失败：' + e.message);
        }
    }

    /* 心跳：告诉扩展"脚本还活着"，超时未报活扩展会自动恢复直连 */
    function startBeat() {
        stopBeat();
        const beat = async () => {
            if (!String(CFG.apiUrl || '').trim()) return;
            try { await bridgeSafe('ping', payloadBase(), 10000); }
            catch (e) { /* 静默，下一轮再说 */ }
        };
        beat();
        beatTimer = setInterval(beat, 60000);
    }
    function stopBeat() {
        if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
    }

    /* 自动定时轮换 */
    function startAutoRotate() {
        stopAutoRotate();
        if (!CFG.autoRotate) return;
        const sec = Math.max(30, Number(CFG.rotateSec) || 300);
        addLog(`⏱ 自动轮换已开启：每 ${sec} 秒换一次`);
        rotateTimer = setInterval(() => {
            if (!busy) doRotate();
        }, sec * 1000);
    }
    function stopAutoRotate() {
        if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
    }

    /* ================= UI ================= */
    const $ = id => document.getElementById(id);
    let panelEl = null;

    function buildPanel() {
        if ($('px-panel')) return;
        const el = document.createElement('div');
        el.id = 'px-panel';
        el.innerHTML = `
<div id="px-head" style="display:flex;align-items:center;justify-content:space-between;
     padding:6px 10px;background:#0d2b4e;border-radius:8px 8px 0 0;cursor:move;">
  <span style="color:#90caf9;font-weight:bold;font-size:12px;">🌐 代理 IP 切换器</span>
  <span style="display:flex;gap:6px;">
    <span id="px-toggle" title="折叠/展开" style="cursor:pointer;color:#90caf9;font-size:12px;">➖</span>
  </span>
</div>
<div id="px-body" style="padding:8px 10px 10px;">

  <div id="px-main">
    <div id="px-status" style="margin-bottom:8px;padding:6px 8px;background:#0d0d1a;
         border-radius:6px;font-size:11px;color:#cfd8dc;line-height:1.7;word-break:break-all;">
      未启用代理
    </div>

    <div style="display:flex;gap:6px;margin-bottom:6px;">
      <button id="px-rotate" style="flex:1;padding:7px;background:#2196F3;color:#fff;border:none;
              border-radius:8px;font-size:12px;font-weight:bold;cursor:pointer;">🔄 换 IP</button>
      <button id="px-direct" style="flex:1;padding:7px;background:#FF9800;color:#fff;border:none;
              border-radius:8px;font-size:12px;font-weight:bold;cursor:pointer;">🔌 改回直连</button>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px;">
      <button id="px-check" style="flex:1;padding:7px;background:#4CAF50;color:#fff;border:none;
              border-radius:8px;font-size:12px;cursor:pointer;">🌐 查看当前 IP</button>
      <button id="px-config" style="flex:1;padding:7px;background:#607D8B;color:#fff;border:none;
              border-radius:8px;font-size:12px;cursor:pointer;">⚙ 配置</button>
    </div>

    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
      <label style="display:flex;align-items:center;gap:4px;color:#cfd8dc;font-size:11px;cursor:pointer;">
        <input id="px-auto" type="checkbox" /> 自动轮换
      </label>
      <input id="px-autosec" type="number" min="30" step="30"
             style="width:64px;box-sizing:border-box;padding:3px 6px;background:#0f3460;
                    border:1px solid #334;border-radius:6px;color:#fff;font-size:11px;outline:none;" />
      <span style="color:#8b93a1;font-size:10px;">秒</span>
    </div>
  </div>

  <div id="px-conf" style="display:none;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <span style="color:#90caf9;font-weight:bold;font-size:12px;">⚙ 配置</span>
      <span id="px-back" style="cursor:pointer;color:#90caf9;font-size:12px;">← 返回</span>
    </div>

    <div style="margin-bottom:4px;color:#90caf9;font-size:11px;">代理服务商</div>
    <select id="px-provider" style="width:100%;box-sizing:border-box;padding:5px 8px;background:#0f3460;
            border:1px solid #334;border-radius:6px;color:#fff;font-size:11px;outline:none;"></select>

    <div style="margin:10px 0 4px;color:#90caf9;font-size:11px;">提取链接（API）</div>
    <textarea id="px-url" rows="4" spellcheck="false"
      style="width:100%;box-sizing:border-box;padding:6px 8px;background:#0f3460;border:1px solid #334;
             border-radius:6px;color:#fff;font-size:10px;outline:none;resize:vertical;
             word-break:break-all;font-family:monospace;"></textarea>

    <div style="margin:10px 0 4px;color:#90caf9;font-size:11px;">认证方式</div>
    <select id="px-auth" style="width:100%;box-sizing:border-box;padding:5px 8px;background:#0f3460;
            border:1px solid #334;border-radius:6px;color:#fff;font-size:11px;outline:none;">
      <option value="whitelist">白名单（IP 授权）</option>
      <option value="password">账号密码</option>
    </select>

    <div id="px-accsrc-wrap" style="display:none;">
      <div style="margin:10px 0 4px;color:#90caf9;font-size:11px;">账号来源</div>
      <select id="px-accsrc" style="width:100%;box-sizing:border-box;padding:5px 8px;background:#0f3460;
              border:1px solid #334;border-radius:6px;color:#fff;font-size:11px;outline:none;">
        <option value="auto">自动从返回结果读取</option>
        <option value="manual">手动填写</option>
      </select>
    </div>

    <div id="px-cred-wrap" style="display:none;">
      <div style="margin:10px 0 4px;color:#90caf9;font-size:11px;">账号 / 密码</div>
      <div style="display:flex;gap:6px;">
        <input id="px-user" type="text" placeholder="账号"
          style="flex:1;min-width:0;box-sizing:border-box;padding:5px 8px;background:#0f3460;
                 border:1px solid #334;border-radius:6px;color:#fff;font-size:11px;outline:none;" />
        <input id="px-pass" type="text" placeholder="密码"
          style="flex:1;min-width:0;box-sizing:border-box;padding:5px 8px;background:#0f3460;
                 border:1px solid #334;border-radius:6px;color:#fff;font-size:11px;outline:none;" />
      </div>
    </div>

    <div style="display:flex;gap:6px;margin-top:10px;">
      <div style="flex:1;min-width:0;">
        <div style="color:#90caf9;font-size:11px;margin-bottom:4px;">最多换几个</div>
        <input id="px-maxretry" type="number" min="1" max="10"
          style="width:100%;box-sizing:border-box;padding:5px 8px;background:#0f3460;
                 border:1px solid #334;border-radius:6px;color:#fff;font-size:11px;outline:none;" />
      </div>
      <div style="flex:1;min-width:0;">
        <div style="color:#90caf9;font-size:11px;margin-bottom:4px;">超时阈值(ms)</div>
        <input id="px-slowms" type="number" min="200" step="100"
          style="width:100%;box-sizing:border-box;padding:5px 8px;background:#0f3460;
                 border:1px solid #334;border-radius:6px;color:#fff;font-size:11px;outline:none;" />
      </div>
    </div>

    <div style="margin:10px 0 4px;color:#90caf9;font-size:11px;">探测地址（留空用默认）</div>
    <input id="px-probeurl" type="text" placeholder="https://www.baidu.com/favicon.ico"
      style="width:100%;box-sizing:border-box;padding:5px 8px;background:#0f3460;border:1px solid #334;
             border-radius:6px;color:#fff;font-size:10px;outline:none;" />

    <div id="px-tip" style="margin-top:10px;padding:6px 8px;background:#0d0d1a;border-radius:6px;
         font-size:10px;color:#8b93a1;line-height:1.6;"></div>
  </div>

  <div style="margin-top:8px;">
    <pre id="px-log" data-full="0" style="margin:0;padding:6px 8px;max-height:150px;overflow:auto;
         background:#0d0d1a;border-radius:6px;font-size:10px;color:#9e9e9e;
         white-space:pre-wrap;word-break:break-all;line-height:1.5;"></pre>
    <div style="display:flex;gap:6px;margin-top:6px;">
      <button id="px-copy" style="flex:1;padding:5px;background:#607D8B;color:#fff;border:none;
              border-radius:6px;font-size:11px;cursor:pointer;">📋 复制日志</button>
      <button id="px-clear" style="flex:1;padding:5px;background:#455A64;color:#fff;border:none;
              border-radius:6px;font-size:11px;cursor:pointer;">🗑 清空</button>
    </div>
  </div>

</div>`;

        el.style.cssText = 'position:fixed;right:14px;bottom:14px;width:300px;z-index:2147483000;' +
            'background:#10243e;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",' +
            '"Microsoft YaHei",sans-serif;font-size:12px;border-radius:8px;' +
            'box-shadow:0 6px 24px rgba(0,0,0,.45);user-select:none;';
        document.body.appendChild(el);
        panelEl = el;
        bindUI();
        syncUI();
        makeDraggable(el);
    }

    function makeDraggable(el) {
        const head = $('px-head');
        let sx = 0, sy = 0, sl = 0, st = 0, dragging = false;
        if (!head) return;
        head.addEventListener('mousedown', (e) => {
            if (e.target.id === 'px-toggle') return;
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            const r = el.getBoundingClientRect();
            sl = r.left; st = r.top;
            el.style.right = 'auto'; el.style.bottom = 'auto';
            el.style.left = sl + 'px'; el.style.top = st + 'px';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            el.style.left = (sl + e.clientX - sx) + 'px';
            el.style.top = (st + e.clientY - sy) + 'px';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    }

    function setBusy(on) {
        const b = $('px-rotate');
        if (b) { b.disabled = !!on; b.style.opacity = on ? '.6' : '1'; b.textContent = on ? '⏳ 切换中...' : '🔄 换 IP'; }
    }

    function bindUI() {
        $('px-toggle').addEventListener('click', () => {
            const b = $('px-body');
            const hidden = b.style.display === 'none';
            b.style.display = hidden ? 'block' : 'none';
            $('px-toggle').textContent = hidden ? '➖' : '➕';
        });

        $('px-rotate').addEventListener('click', () => { doRotate(); });
        $('px-direct').addEventListener('click', () => { doDirect(); });
        $('px-check').addEventListener('click', () => {
            try { window.open(CHECK_IP_URL, '_blank'); addLog('🌐 已打开：' + CHECK_IP_URL); }
            catch (e) { addLog('⚠️ 打开失败：' + e.message); }
        });

        $('px-config').addEventListener('click', () => {
            $('px-main').style.display = 'none';
            $('px-conf').style.display = 'block';
            syncUI();
        });
        $('px-back').addEventListener('click', () => {
            $('px-conf').style.display = 'none';
            $('px-main').style.display = 'block';
            syncUI();
        });

        // 自动轮换
        $('px-auto').addEventListener('change', (e) => {
            CFG.autoRotate = !!e.target.checked;
            saveCfg();
            if (CFG.autoRotate) startAutoRotate(); else { stopAutoRotate(); addLog('⏱ 自动轮换已关闭'); }
        });
        $('px-autosec').addEventListener('change', (e) => {
            const n = parseInt(e.target.value, 10);
            CFG.rotateSec = Math.max(30, isNaN(n) ? 300 : n);
            e.target.value = CFG.rotateSec;
            saveCfg();
            if (CFG.autoRotate) startAutoRotate();
        });

        // 服务商
        const pv = $('px-provider');
        Object.keys(PROVIDERS).forEach(k => {
            const o = document.createElement('option');
            o.value = k; o.textContent = PROVIDERS[k].name;
            pv.appendChild(o);
        });
        pv.addEventListener('change', () => {
            CFG.provider = pv.value;
            const prov = PROVIDERS[CFG.provider] || { name: CFG.provider };
            syncAccountParam();     // 预设不再自带链接，不会覆盖你已填的
            saveCfg(); syncUI();
            addLog('🔧 服务商：' + prov.name);
            if (!CFG.apiUrl) addLog('ℹ️ 请在下方粘贴「' + prov.name + '」的提取链接' + (prov.note ? '（' + prov.note + '）' : ''));
        });

        // 提取链接
        $('px-url').addEventListener('change', (e) => {
            CFG.apiUrl = String(e.target.value || '').trim();
            saveCfg(); addLog('🔧 提取链接已更新');
        });

        // 认证方式
        $('px-auth').addEventListener('change', (e) => {
            CFG.authMode = e.target.value;
            if (syncAccountParam()) addLog('🔧 已同步链接参数');
            saveCfg(); syncUI();
            addLog('🔧 认证方式：' + (CFG.authMode === 'whitelist' ? '白名单' : '账号密码'));
        });

        // 账号来源
        $('px-accsrc').addEventListener('change', (e) => {
            CFG.accountSource = e.target.value;
            if (syncAccountParam()) addLog('🔧 已同步链接参数');
            saveCfg(); syncUI();
            addLog('🔧 账号来源：' + (CFG.accountSource === 'auto' ? '自动读取' : '手动填写'));
        });

        $('px-user').addEventListener('change', (e) => { CFG.username = String(e.target.value || '').trim(); saveCfg(); });
        $('px-pass').addEventListener('change', (e) => { CFG.password = String(e.target.value || '').trim(); saveCfg(); });

        // 判定参数（带钳制）
        $('px-maxretry').addEventListener('change', (e) => {
            const n = parseInt(e.target.value, 10);
            CFG.maxRetry = Math.max(1, Math.min(10, isNaN(n) ? 3 : n));
            e.target.value = CFG.maxRetry;
            saveCfg();
            addLog('🔧 最多换 ' + CFG.maxRetry + ' 个（不合格自动换下一个）');
        });
        $('px-slowms').addEventListener('change', (e) => {
            const n = parseInt(e.target.value, 10);
            CFG.slowMs = Math.max(200, isNaN(n) ? 3000 : n);
            e.target.value = CFG.slowMs;
            saveCfg();
            addLog('🔧 超时阈值：' + CFG.slowMs + 'ms');
        });
        $('px-probeurl').addEventListener('change', (e) => {
            CFG.probeUrl = String(e.target.value || '').trim();
            saveCfg();
            addLog('🔧 探测地址：' + (CFG.probeUrl || '(扩展默认)'));
        });

        // 日志
        $('px-copy').addEventListener('click', () => {
            try {
                GM_setClipboard(logs.join('\n'));
                addLog('📋 日志已复制');
            } catch (e) { addLog('⚠️ 复制失败：' + e.message); }
        });
        $('px-clear').addEventListener('click', () => {
            logs.length = 0;
            const box = $('px-log'); if (box) box.textContent = '';
        });
        $('px-log').addEventListener('click', () => {
            const box = $('px-log');
            box.dataset.full = box.dataset.full === '1' ? '0' : '1';
            addLog('（日志显示：' + (box.dataset.full === '1' ? '全部' : '最近60条') + '）');
        });
    }

    /* 配置 → UI */
    function syncUI() {
        const pv = $('px-provider'); if (pv) pv.value = CFG.provider;
        const url = $('px-url'); if (url) {
            url.value = CFG.apiUrl;
            const sp = PROVIDERS[CFG.provider];
            url.placeholder = (sp && sp.sample) ? ('粘贴提取链接，例：' + sp.sample) : '粘贴服务商生成的完整提取链接';
        }
        const au = $('px-auth'); if (au) au.value = CFG.authMode;
        const as = $('px-accsrc'); if (as) as.value = CFG.accountSource;
        const u = $('px-user'); if (u) u.value = CFG.username;
        const pw = $('px-pass'); if (pw) pw.value = CFG.password;
        const mr = $('px-maxretry'); if (mr) mr.value = CFG.maxRetry;
        const sm = $('px-slowms'); if (sm) sm.value = CFG.slowMs;
        const pu = $('px-probeurl'); if (pu) pu.value = CFG.probeUrl;
        const ar = $('px-auto'); if (ar) ar.checked = !!CFG.autoRotate;
        const asec = $('px-autosec'); if (asec) asec.value = CFG.rotateSec;

        const isPwd = CFG.authMode === 'password';
        if ($('px-accsrc-wrap')) $('px-accsrc-wrap').style.display = isPwd ? 'block' : 'none';
        if ($('px-cred-wrap')) $('px-cred-wrap').style.display = (isPwd && CFG.accountSource === 'manual') ? 'block' : 'none';
        if ($('px-tip')) $('px-tip').textContent = tipText();
    }

    function tipText() {
        const prov = PROVIDERS[CFG.provider];
        const pn = prov && prov.accountParam ? prov.accountParam : '';
        if (CFG.authMode === 'password' && CFG.accountSource === 'auto'
            && pn && accountParamState() === 'absent') {
            return `当前链接不含 ${pn} 参数，已跳过自动改写（不会凭空加参数）。账号仍按实际返回值识别：带账密就自动用，不带就走无账密。`;
        }
        if (CFG.authMode === 'whitelist') {
            return '白名单模式：把本机公网 IP 加到服务商后台白名单，代理不带账密。账密留空即可，填了反而可能认证失败。'
                + (pn && accountParamState() === 'synced' ? `（已把 ${pn} 置为 ${prov.accountOff || '0'}）` : '');
        }
        if (CFG.accountSource === 'auto') {
            return '自动读取：每次提取连同账号密码一起返回（如 "IP:端口 账号 密码"），自动解析并用于认证，你不用填。'
                + (pn && accountParamState() === 'synced' ? `（${pn} 已置为 ${prov.accountOn || '1'}）` : '');
        }
        return '手动填写：填入服务商给的代理账号密码。若后台做了白名单授权，请改回「白名单」并清空这两栏。';
    }

    /* 状态区渲染 */
    let tickTimer = null;
    function renderStatus(cfg) {
        const box = $('px-status');
        if (!box) return;
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
        if (!cfg || !cfg.enabled || !cfg.currentIp) {
            box.innerHTML = '<span style="color:#8b93a1;">未启用代理（直连）</span>';
            return;
        }
        const draw = () => {
            const left = Math.max(0, Math.round(((Number(cfg.ttlSec) || 300) * 1000 - (Date.now() - (cfg.updatedAt || 0))) / 1000));
            const mm = String(Math.floor(left / 60)).padStart(2, '0');
            const ss = String(left % 60).padStart(2, '0');
            const color = left <= 30 ? '#f44336' : (left <= 90 ? '#FF9800' : '#4CAF50');
            const auth = cfg.username ? `认证 ${cfg.username}` : '无账密（白名单）';
            const probe = (cfg.lastProbeMs != null && cfg.lastProbeMs > 0) ? ` · 探测 ${cfg.lastProbeMs}ms` : '';
            box.innerHTML =
                `<div>出口：<b style="color:#90caf9;">${cfg.currentIp}:${cfg.currentPort}</b></div>` +
                `<div style="font-size:10px;color:#8b93a1;">${auth} · 累计 ${cfg.rotateCount || 0} 次${probe}</div>` +
                `<div style="font-size:10px;">剩余 <b style="color:${color};">${mm}:${ss}</b></div>`;
        };
        draw();
        tickTimer = setInterval(draw, 1000);
    }

    /* ================= 启动 ================= */
    function boot() {
        if (!document.body) { setTimeout(boot, 200); return; }
        loadCfg();
        buildPanel();

        // 恢复状态：若扩展里还挂着代理，面板显示出来
        (async () => {
            try {
                const st = await bridgeSafe('status', {}, 5000);
                bridgeReady = true;
                if (st && st.enabled && st.currentIp) {
                    renderStatus(st);
                    startBeat();
                    if (CFG.autoRotate) startAutoRotate();
                    addLog(`🔗 已连接执行器，当前出口 ${st.currentIp}:${st.currentPort}`);
                } else {
                    addLog('🔗 已连接执行器（当前直连）');
                }
            } catch (e) {
                addLog('⚠️ 未连上「代理执行器」扩展，请确认已安装并刷新本页面');
            }
        })();

        try {
            GM_registerMenuCommand('🔄 换 IP', () => doRotate());
            GM_registerMenuCommand('🔌 改回直连', () => doDirect());
            GM_registerMenuCommand('🌐 查看当前 IP', () => window.open(CHECK_IP_URL, '_blank'));
        } catch (e) { /* 部分环境不支持 */ }
    }

    boot();
})();
