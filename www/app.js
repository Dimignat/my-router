/* Kiosk controller.
   Long actions run as detached jobs on the router; we poll until they finish.
   Every user-facing string is plain language — no "VPN", "proxy" or "sing-box". */

'use strict';

var API = '/cgi-bin/router-api';
var POLL_MS = 5000;          // background status refresh
var JOB_POLL_MS = 1000;      // while an action is running
var JOB_TIMEOUT_MS = 90000;

var el = function (id) { return document.getElementById(id); };
var lamp = el('lamp'), headline = el('headline'), sub = el('sub');
var overlay = el('overlay'), overlayText = el('overlay-text');
var toast = el('toast'), footNode = el('foot-node'), footVersion = el('foot-version');
var busy = false, statusTimer = null, toastTimer = null;

/* ---------- helpers ---------- */

function api(action, extra) {
  var url = API + '?action=' + encodeURIComponent(action) + (extra || '');
  return fetch(url, { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function showToast(msg, kind) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = 'toast ' + (kind === 'ok' ? 'is-ok' : kind === 'bad' ? 'is-bad' : '');
  toast.hidden = false;
  toastTimer = setTimeout(function () { toast.hidden = true; }, 5000);
}

function setButtons(disabled) {
  ['btn-reconnect', 'btn-reload', 'btn-update'].forEach(function (id) {
    el(id).disabled = disabled;
  });
}

/* ---------- status ---------- */

function paint(s) {
  if (busy) return;                       // don't fight the overlay
  var ok = s && s.online === 1 && s.vpn_enabled === 1;
  var settling = s && s.settling === 1;
  var partial = s && s.vpn_enabled === 1 && s.online !== 1;

  lamp.className = 'lamp ' + (ok ? 'is-ok' : settling ? 'is-busy' : 'is-bad');

  if (ok) {
    headline.textContent = 'Интернет работает';
    sub.textContent = s.latency ? 'Скорость отклика: ' + s.latency + ' мс' : 'Всё в порядке';
  } else if (settling) {
    // Right after a restart the tunnel is up but no node is chosen yet.
    headline.textContent = 'Подключаемся…';
    sub.textContent = 'Подождите несколько секунд';
  } else if (partial) {
    headline.textContent = 'Нет соединения';
    sub.textContent = 'Нажмите «Переподключиться»';
  } else {
    headline.textContent = 'Защита выключена';
    sub.textContent = 'Нажмите «Перезапустить»';
  }

  footNode.textContent = s && s.node && s.node !== 'unknown'
    ? 'Сервер: ' + String(s.node).replace(/^redshield-/, '').replace(/-out$/, '')
    : (settling ? 'Выбираем сервер…' : '—');

  if (footVersion) {
    footVersion.textContent = s && s.version && s.version !== 'unknown'
      ? 'Версия ' + String(s.version).slice(0, 7)
      : 'Версия не установлена';
  }
}

function refresh() {
  return api('status')
    .then(paint)
    .catch(function () {
      if (busy) return;
      lamp.className = 'lamp is-bad';
      headline.textContent = 'Роутер не отвечает';
      sub.textContent = 'Проверьте, включён ли он';
    });
}

function scheduleRefresh() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(function () { refresh().then(scheduleRefresh); }, POLL_MS);
}

/* ---------- actions ---------- */

function waitForJob(id, started) {
  return api('job_status', '&job=' + encodeURIComponent(id)).then(function (j) {
    if (j.state === 'running') {
      if (Date.now() - started > JOB_TIMEOUT_MS) throw new Error('timeout');
      return new Promise(function (res) { setTimeout(res, JOB_POLL_MS); })
        .then(function () { return waitForJob(id, started); });
    }
    if (j.state === 'failed') throw new Error('failed');
    return j;
  });
}

function run(action, busyText, okText, settleMs) {
  if (busy) return;
  busy = true;
  setButtons(true);
  clearTimeout(statusTimer);

  overlayText.textContent = busyText;
  overlay.hidden = false;
  lamp.className = 'lamp is-busy';

  api(action)
    .then(function (r) {
      if (!r.ok || !r.job) throw new Error(r.error || 'no job');
      return waitForJob(r.job, Date.now());
    })
    // Give the tunnel a moment to settle before we re-test connectivity,
    // otherwise the first status read races the restart and looks like failure.
    .then(function () {
      return new Promise(function (res) { setTimeout(res, settleMs || 2000); });
    })
    .then(function () {
      busy = false;
      overlay.hidden = true;
      return refresh();
    })
    .then(function () { showToast(okText, 'ok'); })
    .catch(function () {
      busy = false;
      overlay.hidden = true;
      showToast('Не получилось. Попробуйте ещё раз.', 'bad');
      return refresh();
    })
    .then(function () {
      setButtons(false);
      scheduleRefresh();
    });
}

el('btn-reconnect').addEventListener('click', function () {
  run('reconnect', 'Переподключаемся…', 'Готово! Соединение обновлено.', 2000);
});

el('btn-reload').addEventListener('click', function () {
  run('reload', 'Перезапускаем…', 'Готово! Всё перезапущено.', 5000);
});

el('btn-update').addEventListener('click', function () {
  if (busy) return;
  busy = true;
  setButtons(true);
  clearTimeout(statusTimer);

  overlayText.textContent = 'Проверяем обновления…';
  overlay.hidden = false;
  lamp.className = 'lamp is-busy';

  var before = null;
  api('status')
    .then(function (s) { before = s && s.version; })
    .then(function () { return api('update'); })
    .then(function (r) {
      if (!r.ok || !r.job) throw new Error(r.error || 'no job');
      return waitForJob(r.job, Date.now());
    })
    .then(function () {
      busy = false;
      overlay.hidden = true;
      return api('status');
    })
    .then(function (s) {
      paint(s);
      // Distinguish "updated" from "already current" — otherwise the user
      // taps again wondering whether anything happened.
      if (s && s.version && s.version !== before && before !== null) {
        showToast('Обновлено! Установлена новая версия.', 'ok');
      } else {
        showToast('У вас уже последняя версия.', 'ok');
      }
    })
    .catch(function () {
      busy = false;
      overlay.hidden = true;
      // The usual cause is no internet, so say that rather than something vague.
      showToast('Не удалось проверить обновления. Нет связи с интернетом?', 'bad');
      return refresh();
    })
    .then(function () {
      setButtons(false);
      scheduleRefresh();
    });
});

/* ---------- start ---------- */

refresh().then(scheduleRefresh);

// Re-check the moment the user comes back to the page.
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && !busy) refresh();
});
