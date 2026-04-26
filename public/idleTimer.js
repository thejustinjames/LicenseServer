/**
 * Session idle timer.
 *
 * Behavior:
 *   - Resets a "last activity" timestamp on mouse/keyboard/scroll/touch.
 *   - At (timeoutMs - warnGapMs), shows a modal: "You'll be signed out
 *     in N seconds — Stay signed in / Log out now". Countdown updates each second.
 *   - At timeoutMs of inactivity, calls /api/auth/logout (best-effort) and
 *     redirects to /.
 *   - Activity in any tab counts: lastActivity is mirrored in localStorage
 *     under `lsLastActivity` and other tabs listen via the `storage` event.
 *   - If any authenticated request returns 401 idle_timeout, the page
 *     immediately logs out (network confirms the server kicked us).
 *
 * Loaded by index.html and admin.html. The single login surface is `/`,
 * so logout always redirects there.
 */
(function () {
  'use strict';

  var STORAGE_KEY_LAST_ACTIVITY = 'lsLastActivity';
  var STORAGE_KEY_LOGOUT_BROADCAST = 'lsIdleLogoutAt';
  var DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
  var DEFAULT_WARN_GAP_MS = 60 * 1000; // show warning 60s before logout

  var timeoutMs = DEFAULT_TIMEOUT_MS;
  var warnGapMs = DEFAULT_WARN_GAP_MS;
  var checkIntervalId = null;
  var countdownIntervalId = null;
  var modalEl = null;
  var countdownEl = null;
  var loggingOut = false;

  function isAuthenticated() {
    // Both surfaces store an access token under lsAccessToken once signed in.
    try { return Boolean(localStorage.getItem('lsAccessToken')); } catch (_) { return false; }
  }

  function now() { return Date.now(); }

  function readLastActivity() {
    try {
      var v = parseInt(localStorage.getItem(STORAGE_KEY_LAST_ACTIVITY) || '', 10);
      return Number.isFinite(v) ? v : 0;
    } catch (_) { return 0; }
  }

  function writeLastActivity(ts) {
    try { localStorage.setItem(STORAGE_KEY_LAST_ACTIVITY, String(ts)); } catch (_) {}
  }

  function recordActivity() {
    if (loggingOut) return;
    if (!isAuthenticated()) return;
    writeLastActivity(now());
    if (modalEl && modalEl.style.display === 'flex') {
      // User came back: hide warning. Server will be touched by their next
      // request — we don't ping just for this.
      hideWarning();
    }
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    var overlay = document.createElement('div');
    overlay.id = 'idleTimeoutModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.6);'
      + 'display:none;align-items:center;justify-content:center;z-index:99999;'
      + 'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';

    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:8px;padding:1.75rem 2rem;'
      + 'max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);'
      + 'color:#1e293b;';

    var h = document.createElement('h2');
    h.textContent = 'You will be signed out';
    h.style.cssText = 'margin:0 0 0.75rem;font-size:1.25rem;color:#1e293b;';
    box.appendChild(h);

    var p = document.createElement('p');
    p.style.cssText = 'margin:0 0 1.25rem;color:#475569;line-height:1.5;';
    p.appendChild(document.createTextNode('For your security, your session will end in '));
    countdownEl = document.createElement('strong');
    countdownEl.textContent = '60';
    countdownEl.style.color = '#dc2626';
    p.appendChild(countdownEl);
    p.appendChild(document.createTextNode(' seconds due to inactivity.'));
    box.appendChild(p);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:0.5rem;justify-content:flex-end;';

    var logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.textContent = 'Log out now';
    logoutBtn.style.cssText = 'padding:0.5rem 1rem;border:1px solid #cbd5e1;'
      + 'background:#f8fafc;color:#1e293b;border-radius:6px;cursor:pointer;';
    logoutBtn.onclick = function () { performLogout('manual'); };
    actions.appendChild(logoutBtn);

    var stayBtn = document.createElement('button');
    stayBtn.type = 'button';
    stayBtn.textContent = 'Stay signed in';
    stayBtn.style.cssText = 'padding:0.5rem 1rem;border:0;background:#2563eb;'
      + 'color:#fff;border-radius:6px;cursor:pointer;font-weight:500;';
    stayBtn.onclick = function () {
      hideWarning();
      // Send a lightweight authenticated request so the server-side idle
      // entry is refreshed for this jti — otherwise the user's "stay" only
      // resets the local timer, and the next real call could still 401.
      fetch('/api/auth/heartbeat', {
        credentials: 'include',
        headers: tokenHeader(),
      }).catch(function () {});
      recordActivity();
    };
    actions.appendChild(stayBtn);

    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    modalEl = overlay;
    return overlay;
  }

  function tokenHeader() {
    try {
      var t = localStorage.getItem('lsAccessToken');
      return t ? { 'Authorization': 'Bearer ' + t } : {};
    } catch (_) { return {}; }
  }

  function showWarning() {
    ensureModal();
    modalEl.style.display = 'flex';
    updateCountdown();
    if (countdownIntervalId) clearInterval(countdownIntervalId);
    countdownIntervalId = setInterval(updateCountdown, 1000);
  }

  function hideWarning() {
    if (modalEl) modalEl.style.display = 'none';
    if (countdownIntervalId) {
      clearInterval(countdownIntervalId);
      countdownIntervalId = null;
    }
  }

  function updateCountdown() {
    if (!countdownEl) return;
    var remaining = Math.max(0, timeoutMs - (now() - readLastActivity()));
    countdownEl.textContent = String(Math.ceil(remaining / 1000));
    if (remaining <= 0) {
      performLogout('idle');
    }
  }

  function performLogout(reason) {
    if (loggingOut) return;
    loggingOut = true;
    hideWarning();
    try { localStorage.setItem(STORAGE_KEY_LOGOUT_BROADCAST, String(now())); } catch (_) {}

    var done = function () {
      try {
        localStorage.removeItem('lsAccessToken');
        localStorage.removeItem('lsRefreshToken');
        localStorage.removeItem('lsUser');
        localStorage.removeItem(STORAGE_KEY_LAST_ACTIVITY);
      } catch (_) {}
      var qs = reason === 'idle' ? '?reason=idle' : '';
      window.location.href = '/' + qs;
    };

    var t;
    try { t = localStorage.getItem('lsAccessToken'); } catch (_) { t = null; }
    var headers = { 'Content-Type': 'application/json' };
    if (t) headers['Authorization'] = 'Bearer ' + t;

    // Best-effort: hit both logout endpoints. If the server already
    // expired the session we still want the client to clear and redirect.
    var body = JSON.stringify(t ? { accessToken: t } : {});
    var unifiedLogout = fetch('/api/auth/logout', {
      method: 'POST', credentials: 'include', headers: headers, body: body,
    }).catch(function () {});
    var portalLogout = fetch('/api/portal/auth/logout', {
      method: 'POST', credentials: 'include', headers: headers,
    }).catch(function () {});

    Promise.all([unifiedLogout, portalLogout]).then(done, done);

    // Hard fallback in case both fetches hang.
    setTimeout(done, 2500);
  }

  function check() {
    if (loggingOut) return;
    if (!isAuthenticated()) return;
    var idleFor = now() - readLastActivity();
    if (idleFor >= timeoutMs) {
      performLogout('idle');
      return;
    }
    if (idleFor >= timeoutMs - warnGapMs) {
      if (!modalEl || modalEl.style.display !== 'flex') showWarning();
    }
  }

  function attachListeners() {
    var events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'];
    var throttle = 0;
    var handler = function () {
      var t = now();
      // Don't write to localStorage on every mousemove — once a second is plenty.
      if (t - throttle < 1000) return;
      throttle = t;
      recordActivity();
    };
    for (var i = 0; i < events.length; i++) {
      window.addEventListener(events[i], handler, { passive: true });
    }

    window.addEventListener('storage', function (e) {
      if (e.key === STORAGE_KEY_LOGOUT_BROADCAST) {
        // Another tab logged out — follow it.
        performLogout('cross-tab');
      }
      // For STORAGE_KEY_LAST_ACTIVITY we don't need to do anything: the next
      // check() reads the latest value from localStorage.
    });

    // When tab regains focus, immediately re-check (in case it was idle in
    // background longer than the polling interval).
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') check();
    });
  }

  function patchFetch() {
    if (!window.fetch || window.__lsIdleFetchPatched) return;
    window.__lsIdleFetchPatched = true;
    var originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      return originalFetch(input, init).then(function (resp) {
        if (resp && resp.status === 401) {
          // Peek at body without consuming it for the caller.
          var cloned;
          try { cloned = resp.clone(); } catch (_) { return resp; }
          cloned.json().then(function (body) {
            if (body && body.code === 'idle_timeout') performLogout('server');
          }).catch(function () {});
        }
        return resp;
      });
    };
  }

  function loadConfigAndStart() {
    fetch('/api/auth/idle-config', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (cfg && cfg.timeoutMs > 0) timeoutMs = cfg.timeoutMs;
        if (cfg && cfg.warnMs > 0 && cfg.warnMs < timeoutMs) {
          warnGapMs = timeoutMs - cfg.warnMs;
        }
      })
      .catch(function () {})
      .then(start);
  }

  function start() {
    attachListeners();
    patchFetch();
    // Seed activity now so the timer doesn't fire immediately after page load.
    if (isAuthenticated() && !readLastActivity()) writeLastActivity(now());
    if (checkIntervalId) clearInterval(checkIntervalId);
    checkIntervalId = setInterval(check, 5000);
    check();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadConfigAndStart);
  } else {
    loadConfigAndStart();
  }

  // Expose for app.js / admin.js to call after a successful login so the
  // timer starts cleanly without waiting for the next interval.
  window.LicenseServerIdleTimer = {
    onLogin: function () {
      writeLastActivity(now());
      loggingOut = false;
    },
    onLogout: function () {
      loggingOut = false;
      try { localStorage.removeItem(STORAGE_KEY_LAST_ACTIVITY); } catch (_) {}
    },
  };
})();
