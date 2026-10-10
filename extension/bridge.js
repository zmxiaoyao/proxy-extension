/* bridge.js —— 页面 ⇄ 扩展 的消息桥（content script，MV3）
 *
 * 为什么用 postMessage：
 *   油猴脚本跑在 Tampermonkey 沙箱（@grant 非 none 时）或页面上下文，
 *   与本扩展的 content script 处于不同的 isolated world，无法直接互调；
 *   但两边都指向同一个底层 DOM window，postMessage 是唯一两边都能收发的通道。
 *
 * 兼容性要点：
 *   - 油猴侧用 unsafeWindow 收发（sandbox 模式下 window 是包装过的代理）
 *   - 本文件运行在 isolated world，这里的 window 就是真实页面 window
 *   两者底层同一个 window，因此消息可以互通。
 */
(function () {
  'use strict';
  const FROM_PAGE = 'MT_PROXY_BRIDGE';   // 页面 → 扩展
  const FROM_EXT  = 'MT_PROXY_EXT';      // 扩展 → 页面

  function reply(payload) {
    window.postMessage(payload, '*');
  }

  window.addEventListener('message', function (ev) {
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.__src !== FROM_PAGE) return;

    const action = d.action;
    const id = d.id;

    function done(payload) {
      reply(Object.assign({ __src: FROM_EXT, id: id }, payload));
    }

    /* 扩展被重载 / 更新 / 禁用后，本 content script 会变成 "orphaned"，
     * 此时 sendMessage 会同步抛 "Extension context invalidated"，或回调里给出
     * "message port closed"。这里统一转成可操作的提示，而不是让调用方干等超时。 */
    function humanize(err) {
      const m = String((err && err.message) || err);
      if (/invalidated|port closed|disconnected|context/i.test(m)) {
        return '扩展已重载或更新，请刷新本页后重试';
      }
      return m;
    }

    try {
      chrome.runtime.sendMessage({ type: action, payload: d.payload || {} }, function (res) {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) {
          done({ ok: false, error: humanize(err) });
          return;
        }
        try {
          // 只回传可结构化克隆的纯数据
          done({ ok: true, result: res === undefined ? null : JSON.parse(JSON.stringify(res)) });
        } catch (e) {
          done({ ok: true, result: null });
        }
      });
    } catch (e) {
      done({ ok: false, error: humanize(e) });
    }
  });
})();
