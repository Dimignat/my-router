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
  ['btn-reconnect', 'btn-reload', 'btn-update', 'btn-reboot', 'btn-country'].forEach(function (id) {
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
  } else if (s && s.reason === 'wan') {
    // No uplink at all: no button on this page can fix that.
    headline.textContent = 'Нет интернета';
    sub.textContent = 'Проверьте кабель или подключение к сети';
  } else if (s && s.reason === 'nodes') {
    // Uplink is fine, the proxy servers are the problem.
    headline.textContent = 'Серверы недоступны';
    sub.textContent = 'Нажмите «Переподключиться»';
  } else if (s && s.reason === 'off') {
    headline.textContent = 'Защита выключена';
    sub.textContent = 'Нажмите «Перезапустить»';
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

function run(action, busyText, okText, settleMs, extra) {
  if (busy) return;
  busy = true;
  setButtons(true);
  clearTimeout(statusTimer);

  overlayText.textContent = busyText;
  overlay.hidden = false;
  lamp.className = 'lamp is-busy';

  api(action, extra)
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

/* ---------- country picker ---------- */

// Flags come from the ISO code, so no image assets are needed.
function flagOf(code) {
  if (!code || code.length !== 2) return '\uD83C\uDF10';           // globe
  return String.fromCodePoint.apply(null, code.toUpperCase().split('')
    .map(function (c) { return 0x1F1E6 + c.charCodeAt(0) - 65; }));
}

function renderCountries(data) {
  var list = el('country-list');
  list.textContent = '';

  var auto = document.createElement('button');
  auto.type = 'button';
  auto.className = 'country country-auto' + (data.auto ? ' is-active' : '');
  auto.innerHTML =
    '<span class="country-flag" aria-hidden="true">\u2728</span>' +
    '<span class="country-text">' +
      '<span class="country-name">Автоматически</span>' +
      '<span class="country-city">Самый быстрый сервер</span>' +
    '</span>' +
    '<span class="country-state">' + (data.auto ? 'Сейчас' : '') + '</span>';
  auto.addEventListener('click', function () { pickCountry('auto'); });
  list.appendChild(auto);

  (data.servers || []).forEach(function (sv) {
    var down = sv.latency === null || sv.latency === undefined;
    // Only call it "current" when not in auto mode, or the user sees two rows
    // both claiming to be active.
    var isCurrent = sv.active && !data.auto;

    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'country' + (isCurrent ? ' is-active' : '') + (down ? ' is-down' : '');

    var state = isCurrent ? 'Сейчас'
              : down ? 'Недоступен'
              : sv.latency + ' мс';

    b.innerHTML =
      '<span class="country-flag" aria-hidden="true">' + flagOf(sv.code) + '</span>' +
      '<span class="country-text">' +
        '<span class="country-name"></span>' +
        '<span class="country-city"></span>' +
      '</span>' +
      '<span class="country-state"></span>';
    // Set text via textContent so server-supplied strings are never parsed.
    b.querySelector('.country-name').textContent = sv.country || sv.tag;
    b.querySelector('.country-city').textContent = sv.city || '';
    b.querySelector('.country-state').textContent = state;

    b.addEventListener('click', function () { pickCountry(sv.tag); });
    list.appendChild(b);
  });
}

function openCountries() {
  if (busy) return;
  var list = el('country-list');
  list.textContent = '';
  var loading = document.createElement('p');
  loading.className = 'sheet-note';
  loading.textContent = 'Загружаем список…';
  list.appendChild(loading);
  el('countries').hidden = false;

  api('servers')
    .then(renderCountries)
    .catch(function () {
      list.textContent = '';
      var err = document.createElement('p');
      err.className = 'sheet-note';
      err.textContent = 'Не удалось загрузить список.';
      list.appendChild(err);
    });
}

function pickCountry(tag) {
  el('countries').hidden = true;
  var label = tag === 'auto' ? 'Выбираем лучший сервер…' : 'Переключаем страну…';
  var okMsg = tag === 'auto' ? 'Готово! Сервер выбирается автоматически.'
                             : 'Готово! Страна изменена.';
  run('select', label, okMsg, 3000, '&node=' + encodeURIComponent(tag));
}

el('btn-country').addEventListener('click', openCountries);
el('country-close').addEventListener('click', function () {
  el('countries').hidden = true;
});

el('btn-reboot').addEventListener('click', function () {
  if (busy) return;
  el('confirm').hidden = false;
});

el('confirm-no').addEventListener('click', function () {
  el('confirm').hidden = true;
});

el('confirm-yes').addEventListener('click', function () {
  el('confirm').hidden = true;
  if (busy) return;
  busy = true;
  setButtons(true);
  clearTimeout(statusTimer);

  overlayText.textContent = 'Перезагружаем роутер…';
  overlay.hidden = false;
  lamp.className = 'lamp is-busy';

  // The router goes away mid-request, so a failed fetch here is expected and
  // must not be reported as an error.
  api('reboot').catch(function () {});

  // Poll until the router answers again, then reload to a clean page.
  var deadline = Date.now() + 180000;
  (function waitForBack() {
    setTimeout(function () {
      fetch(API + '?action=status', { cache: 'no-store' })
        .then(function (r) { return r.ok ? location.reload() : Promise.reject(); })
        .catch(function () {
          if (Date.now() < deadline) return waitForBack();
          busy = false;
          overlay.hidden = true;
          setButtons(false);
          showToast('Роутер долго не отвечает. Обновите страницу.', 'bad');
        });
    }, 5000);
  })();
});

/* ---------- intro ---------- */

// The animation is pure CSS, so the page is usable even if this never runs.
// This only tidies up: drop the splash node once it has played, and let a tap
// skip the remainder for anyone who does not want to wait.
(function () {
  var splash = el('splash');
  if (!splash) return;

  var done = false;
  function finish() {
    if (done) return;
    done = true;
    document.body.classList.remove('intro');
    if (splash.parentNode) splash.parentNode.removeChild(splash);
  }

  splash.addEventListener('animationend', finish);
  document.addEventListener('pointerdown', finish, { once: true });
  // Backstop in case animationend never fires (animation disabled, tab
  // backgrounded during load, older browser).
  setTimeout(finish, 2600);
})();

/* ---------- start ---------- */

refresh().then(scheduleRefresh);

// Re-check the moment the user comes back to the page.
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && !busy) refresh();
});
