'use strict';

const $ = (selector, root = document) => root.querySelector(selector);

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

const DEFAULT_SETTINGS = {
  clock24: true,
  wakeLock: true,
  units: 'celsius',
  location: null, // { name, lat, lon }
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4,
  autoStart: false,
  sound: true,
};

let settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const formatTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !settings.clock24 });

function isoWithOffset(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/* ---------------- Clock ---------------- */

let lastDay = dayKey();
let lastMinute = -1;

function renderClock() {
  const now = new Date();
  let hours = now.getHours();
  let suffix = '';
  if (!settings.clock24) {
    suffix = hours < 12 ? 'AM' : 'PM';
    hours = hours % 12 || 12;
  }
  $('#time').textContent = `${settings.clock24 ? pad(hours) : hours}:${pad(now.getMinutes())}`;
  $('#time-suffix').textContent = suffix;
  $('#date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  if (now.getMinutes() !== lastMinute) {
    lastMinute = now.getMinutes();
    onMinute();
  }
  if (dayKey(now) !== lastDay) {
    lastDay = dayKey(now);
    onNewDay();
  }
}

function onMinute() {
  // Small random shift so static pixels don't burn into the OLED panel.
  const root = document.documentElement.style;
  root.setProperty('--shift-x', `${Math.round(Math.random() * 6 - 3)}px`);
  root.setProperty('--shift-y', `${Math.round(Math.random() * 6 - 3)}px`);
  renderAgenda();
}

function onNewDay() {
  pomodoro.rollDay();
  loadAgenda();
  loadWeather();
}

/* ---------------- Weather (Open-Meteo, no API key) ---------------- */

const WEATHER_CODES = {
  0: ['☀️', 'Clear'], 1: ['🌤️', 'Mainly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Freezing fog'],
  51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'],
  56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'],
  61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
  66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
  71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
  80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Heavy showers'],
  85: ['🌨️', 'Snow showers'], 86: ['🌨️', 'Snow showers'],
  95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm, hail'], 99: ['⛈️', 'Thunderstorm, hail'],
};

function geolocate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation unavailable'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ name: '', lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) }),
      reject,
      { timeout: 15000, maximumAge: 3600e3 },
    );
  });
}

function renderWeather(data) {
  const el = $('#weather');
  if (!data) {
    el.className = 'weather muted';
    el.textContent = 'Set a location in settings to see the weather.';
    return;
  }
  const { current, daily } = data;
  let [icon, label] = WEATHER_CODES[current.weather_code] || ['🌡️', 'Weather'];
  if (!current.is_day && current.weather_code <= 1) icon = '🌙';
  const unit = settings.units === 'fahrenheit' ? '°F' : '°C';
  const rain = daily.precipitation_probability_max?.[0];
  el.className = 'weather';
  el.replaceChildren();
  const iconEl = Object.assign(document.createElement('span'), { className: 'weather-icon', textContent: icon });
  const tempEl = Object.assign(document.createElement('span'), { className: 'weather-temp', textContent: `${Math.round(current.temperature_2m)}°` });
  const meta = Object.assign(document.createElement('span'), { className: 'weather-meta muted' });
  const line1 = document.createElement('span');
  line1.textContent = `${label}${settings.location?.name ? ` · ${settings.location.name}` : ''}`;
  const line2 = document.createElement('span');
  line2.textContent = `H ${Math.round(daily.temperature_2m_max[0])}${unit}  L ${Math.round(daily.temperature_2m_min[0])}${unit}` +
    (rain != null ? `  ·  ${rain}% rain` : '');
  meta.append(line1, line2);
  el.append(iconEl, tempEl, meta);
}

async function loadWeather() {
  if (!settings.location) {
    try {
      settings.location = await geolocate();
      saveSettings();
    } catch {
      renderWeather(null);
      return;
    }
  }
  const { lat, lon } = settings.location;
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'temperature_2m,weather_code,is_day',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    temperature_unit: settings.units,
    timezone: 'auto',
    forecast_days: '1',
  });
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    store.set('weather', data);
    renderWeather(data);
  } catch {
    const cached = store.get('weather', null);
    if (cached) renderWeather(cached);
    else $('#weather').textContent = 'Weather unavailable (offline?)';
  }
}

async function searchCity(name) {
  const params = new URLSearchParams({ name, count: '5', format: 'json' });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
  if (!res.ok) throw new Error(res.statusText);
  return (await res.json()).results || [];
}

/* ---------------- Agenda (Outlook ICS via server.py) ---------------- */

let agenda = store.get('agenda', null); // { events, fetchedAt }
let agendaStatus = '';

async function loadAgenda() {
  const start = startOfDay(new Date());
  const end = addDays(start, 2);
  const query = new URLSearchParams({ start: isoWithOffset(start), end: isoWithOffset(end) });
  try {
    const res = await fetch(`/api/agenda?${query}`, { cache: 'no-store' });
    const isJson = (res.headers.get('content-type') || '').includes('json');
    if (!isJson) throw new Error('Agenda needs server.py (see README)');
    const data = await res.json();
    if (!data.configured) {
      agenda = null;
      agendaStatus = 'Add your Outlook calendar link to config.json to see your agenda.';
    } else if (data.error) {
      throw new Error(data.error);
    } else {
      agenda = { events: data.events, fetchedAt: Date.now(), day: dayKey() };
      store.set('agenda', agenda);
      agendaStatus = data.stale ? 'Showing last synced events (calendar unreachable).' : '';
    }
  } catch (err) {
    agendaStatus = agenda ? 'Offline: showing last synced events.' : `Calendar unavailable. ${err.message}`;
  }
  renderAgenda();
}

function expandEvents(events, from, days) {
  // Normalise to { title, location, start: Date, end: Date, allDay } and bucket by local day.
  const buckets = [];
  for (let i = 0; i < days; i++) buckets.push({ date: addDays(from, i), items: [] });
  for (const ev of events) {
    let start, end;
    if (ev.allDay) {
      const [ys, ms, ds] = ev.start.split('-').map(Number);
      const [ye, me, de] = ev.end.split('-').map(Number);
      start = new Date(ys, ms - 1, ds);
      end = new Date(ye, me - 1, de);
    } else {
      start = new Date(ev.start);
      end = new Date(ev.end);
    }
    for (const bucket of buckets) {
      const dayStart = bucket.date;
      const dayEnd = addDays(dayStart, 1);
      const overlaps = start < dayEnd && (end > dayStart || (+end === +start && start >= dayStart));
      if (overlaps) bucket.items.push({ ...ev, start, end });
    }
  }
  for (const bucket of buckets) {
    bucket.items.sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start) || a.title.localeCompare(b.title));
  }
  return buckets;
}

function renderAgenda() {
  const list = $('#agenda-list');
  const status = $('#agenda-status');
  list.replaceChildren();
  status.textContent = agendaStatus;
  if (!agenda) return;

  const now = new Date();
  const buckets = expandEvents(agenda.events, startOfDay(now), 2);
  let nextMarked = false;
  let anything = false;

  buckets.forEach((bucket, i) => {
    const isToday = i === 0;
    // Hide finished timed events today to keep the list short.
    const items = bucket.items.filter((ev) => !(isToday && !ev.allDay && ev.end <= now));
    if (!items.length && !isToday) return;

    const heading = document.createElement('div');
    heading.className = 'agenda-day';
    heading.textContent = isToday ? 'Today' : i === 1 ? 'Tomorrow'
      : bucket.date.toLocaleDateString(undefined, { weekday: 'long' });
    list.append(heading);

    if (!items.length) {
      const empty = Object.assign(document.createElement('div'), { className: 'muted small', textContent: 'Nothing else today' });
      list.append(empty);
      return;
    }

    for (const ev of items) {
      anything = true;
      const row = document.createElement('div');
      row.className = 'event';
      const time = document.createElement('div');
      time.className = 'event-time';
      time.textContent = ev.allDay ? 'All day' : formatTime(ev.start);
      const body = document.createElement('div');
      body.style.minWidth = '0';
      const title = document.createElement('div');
      title.className = 'event-title';
      title.textContent = ev.title;

      if (isToday && !ev.allDay) {
        if (ev.start <= now && now < ev.end) {
          row.classList.add('is-now');
          title.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'Now' }));
        } else if (!nextMarked && ev.start > now) {
          nextMarked = true;
          row.classList.add('is-next');
          const mins = Math.round((ev.start - now) / 60000);
          if (mins <= 120) {
            const label = mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
            title.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: label }));
          }
        }
      }
      body.append(title);
      const subParts = [];
      if (!ev.allDay) subParts.push(`until ${formatTime(ev.end)}`);
      if (ev.location) subParts.push(ev.location);
      if (subParts.length) {
        body.append(Object.assign(document.createElement('div'), { className: 'event-sub', textContent: subParts.join(' · ') }));
      }
      row.append(time, body);
      list.append(row);
    }
  });

  if (!anything && !agendaStatus) status.textContent = 'Nothing scheduled for today or tomorrow.';
}

/* ---------------- To-do ---------------- */

let todos = store.get('todos', []);
let selectedTodo = null;
const saveTodos = () => store.set('todos', todos);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';

function renderTodos() {
  const list = $('#todo-list');
  list.replaceChildren();
  for (const todo of todos) {
    const li = document.createElement('li');
    li.className = 'todo';
    li.dataset.id = todo.id;
    li.classList.toggle('done', todo.done);
    li.classList.toggle('selected', todo.id === selectedTodo);
    li.classList.toggle('is-focus', todo.id === pomodoro.state.taskId);

    const main = document.createElement('div');
    main.className = 'todo-main';
    const check = document.createElement('button');
    check.className = 'todo-check';
    check.dataset.action = 'toggle';
    check.setAttribute('aria-label', todo.done ? 'Mark not done' : 'Mark done');
    check.innerHTML = CHECK_SVG;
    const text = document.createElement('button');
    text.className = 'todo-text';
    text.dataset.action = 'select';
    text.textContent = todo.text;
    main.append(check, text);

    const actions = document.createElement('div');
    actions.className = 'todo-actions';
    const focusLabel = todo.id === pomodoro.state.taskId ? 'Unfocus' : 'Focus';
    for (const [action, label, cls] of [['focus', focusLabel], ['up', '↑'], ['down', '↓'], ['delete', 'Delete', 'danger']]) {
      const btn = document.createElement('button');
      btn.dataset.action = action;
      btn.textContent = label;
      if (cls) btn.className = cls;
      actions.append(btn);
    }
    li.append(main, actions);
    list.append(li);
  }

  const open = todos.filter((t) => !t.done).length;
  $('#todo-count').textContent = todos.length ? `${open} left` : '';
  $('#todo-empty').hidden = todos.length > 0;
  $('#todo-clear').hidden = !todos.some((t) => t.done);
}

function initTodos() {
  $('#todo-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#todo-input');
    const text = input.value.trim();
    if (!text) return;
    todos.unshift({ id: newId(), text, done: false });
    input.value = '';
    saveTodos();
    renderTodos();
  });

  $('#todo-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('.todo').dataset.id;
    const index = todos.findIndex((t) => t.id === id);
    const todo = todos[index];
    switch (btn.dataset.action) {
      case 'toggle':
        todo.done = !todo.done;
        // Move finished items below open ones.
        todos.splice(index, 1);
        if (todo.done) todos.push(todo);
        else todos.unshift(todo);
        if (todo.done && pomodoro.state.taskId === id) pomodoro.setTask(null);
        break;
      case 'select':
        selectedTodo = selectedTodo === id ? null : id;
        break;
      case 'focus':
        pomodoro.setTask(pomodoro.state.taskId === id ? null : id);
        selectedTodo = null;
        break;
      case 'up':
        if (index > 0) [todos[index - 1], todos[index]] = [todos[index], todos[index - 1]];
        break;
      case 'down':
        if (index < todos.length - 1) [todos[index + 1], todos[index]] = [todos[index], todos[index + 1]];
        break;
      case 'delete':
        todos.splice(index, 1);
        if (pomodoro.state.taskId === id) pomodoro.setTask(null);
        selectedTodo = null;
        break;
    }
    saveTodos();
    renderTodos();
  });

  $('#todo-clear').addEventListener('click', () => {
    todos = todos.filter((t) => !t.done);
    saveTodos();
    renderTodos();
  });

  renderTodos();
}

/* ---------------- Pomodoro ---------------- */

const PHASES = {
  focus: { label: 'Focus', setting: 'focusMin' },
  short: { label: 'Short break', setting: 'shortMin' },
  long: { label: 'Long break', setting: 'longMin' },
};
const RING_LENGTH = 2 * Math.PI * 45;

const pomodoro = {
  state: null,

  duration(phase = this.state.phase) {
    return settings[PHASES[phase].setting] * 60e3;
  },

  remaining() {
    return this.state.running ? Math.max(0, this.state.endAt - Date.now()) : this.state.remaining;
  },

  fresh() {
    return { phase: 'focus', running: false, endAt: 0, remaining: settings.focusMin * 60e3, streak: 0, doneToday: 0, day: dayKey(), taskId: null };
  },

  init() {
    this.state = { ...this.fresh(), ...store.get('pomodoro', {}) };
    this.rollDay();
    // A session may have finished while the page was closed.
    if (this.state.running && this.state.endAt <= Date.now()) this.finish(false);

    $('#pomo-progress').style.strokeDasharray = RING_LENGTH;
    $('#pomo-toggle').addEventListener('click', () => (this.state.running ? this.pause() : this.start()));
    $('#pomo-reset').addEventListener('click', () => this.reset());
    $('#pomo-skip').addEventListener('click', () => this.advance(false));
    setInterval(() => this.tick(), 250);
    this.render();
  },

  save() { store.set('pomodoro', this.state); },

  rollDay() {
    if (this.state.day !== dayKey()) {
      Object.assign(this.state, { day: dayKey(), doneToday: 0, streak: 0 });
      this.save();
      this.render();
    }
  },

  start() {
    unlockAudio();
    requestNotifications();
    this.state.endAt = Date.now() + this.state.remaining;
    this.state.running = true;
    this.save();
    this.render();
  },

  pause() {
    this.state.remaining = this.remaining();
    this.state.running = false;
    this.save();
    this.render();
  },

  reset() {
    this.state.running = false;
    this.state.remaining = this.duration();
    this.save();
    this.render();
  },

  advance(completed) {
    const s = this.state;
    if (s.phase === 'focus') {
      if (completed) {
        s.doneToday += 1;
        s.streak += 1;
      }
      s.phase = completed && s.streak % settings.longEvery === 0 ? 'long' : 'short';
    } else {
      s.phase = 'focus';
    }
    s.running = false;
    s.remaining = this.duration();
    if (completed && settings.autoStart) {
      s.running = true;
      s.endAt = Date.now() + s.remaining;
    }
    this.save();
    this.render();
  },

  finish(alert = true) {
    const ended = PHASES[this.state.phase].label;
    this.advance(true);
    if (!alert) return;
    chime();
    navigator.vibrate?.([300, 150, 300]);
    const next = PHASES[this.state.phase].label;
    notify(`${ended} finished`, this.state.running ? `${next} started.` : `Next: ${next}.`);
  },

  setTask(id) {
    this.state.taskId = id;
    this.save();
    this.render();
  },

  tick() {
    if (this.state.running && this.remaining() <= 0) this.finish();
    this.renderTime();
  },

  renderTime() {
    const ms = this.remaining();
    const totalSec = Math.ceil(ms / 1000);
    const text = `${pad(Math.floor(totalSec / 60))}:${pad(totalSec % 60)}`;
    $('#pomo-time').textContent = text;
    const fraction = Math.min(1, ms / this.duration());
    $('#pomo-progress').style.strokeDashoffset = RING_LENGTH * (1 - fraction);
    document.title = this.state.running ? `${text} · ${PHASES[this.state.phase].label}` : 'Desk Companion';
  },

  render() {
    const s = this.state;
    const panel = $('#pomo');
    panel.dataset.phase = s.phase;
    panel.classList.toggle('running', s.running);
    $('#pomo-phase').textContent = PHASES[s.phase].label;
    $('#pomo-toggle').setAttribute('aria-label', s.running ? 'Pause' : 'Start');

    const task = todos.find((t) => t.id === s.taskId);
    $('#pomo-task').textContent = task ? task.text : (s.phase === 'focus' ? 'Tap a to-do, then "Focus"' : 'Take a breather');

    const dots = s.doneToday <= 8 ? '●'.repeat(s.doneToday) : `● × ${s.doneToday}`;
    $('#pomo-count').textContent = s.doneToday ? `${dots}  today` : 'No sessions yet today';
    this.renderTime();
    renderTodos();
  },
};

/* ---------------- Sound & notifications ---------------- */

let audioCtx = null;

function unlockAudio() {
  // Browsers only allow audio after a user gesture, so create it on the first Start tap.
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio support */ }
}

function chime() {
  if (!settings.sound || !audioCtx) return;
  const t0 = audioCtx.currentTime;
  [660, 880, 1320].forEach((freq, i) => {
    const at = t0 + i * 0.22;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + 0.75);
  });
}

function requestNotifications() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !navigator.serviceWorker) return;
  // Android Chrome only shows notifications through the service worker.
  navigator.serviceWorker.ready
    .then((reg) => reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag: 'pomodoro', renotify: true }))
    .catch(() => {});
}

/* ---------------- Screen wake lock & fullscreen ---------------- */

let wakeLock = null;

async function updateWakeLock() {
  if (!('wakeLock' in navigator)) return;
  const want = settings.wakeLock && document.visibilityState === 'visible';
  if (want && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* denied, e.g. battery saver */ }
  } else if (!want && wakeLock) {
    await wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
}

/* ---------------- Settings dialog ---------------- */

function initSettings() {
  const dialog = $('#settings');
  const form = $('#settings-form');
  let draftLocation = settings.location;

  const showLocation = () => {
    $('#settings-location').textContent = draftLocation
      ? (draftLocation.name || `${draftLocation.lat}, ${draftLocation.lon}`)
      : 'Not set';
  };

  $('#btn-settings').addEventListener('click', () => {
    draftLocation = settings.location;
    for (const [key, value] of Object.entries(settings)) {
      const field = form.elements[key];
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = value;
      else field.value = value;
    }
    $('#city-results').replaceChildren();
    $('#city-input').value = '';
    showLocation();
    dialog.showModal();
  });

  $('#btn-geolocate').addEventListener('click', async () => {
    $('#settings-location').textContent = 'Locating…';
    try {
      draftLocation = await geolocate();
    } catch {
      $('#settings-location').textContent = 'Location permission denied';
      return;
    }
    showLocation();
  });

  const runCitySearch = async () => {
    const name = $('#city-input').value.trim();
    const results = $('#city-results');
    if (!name) return;
    results.textContent = 'Searching…';
    try {
      const cities = await searchCity(name);
      results.replaceChildren();
      if (!cities.length) results.textContent = 'No matches';
      for (const c of cities) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = [c.name, c.admin1, c.country].filter(Boolean).join(', ');
        btn.addEventListener('click', () => {
          draftLocation = { name: c.name, lat: c.latitude, lon: c.longitude };
          results.replaceChildren();
          showLocation();
        });
        results.append(btn);
      }
    } catch {
      results.textContent = 'Search failed (offline?)';
    }
  };
  $('#btn-city').addEventListener('click', runCitySearch);
  $('#city-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runCitySearch(); }
  });

  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    const before = { ...settings };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const field = form.elements[key];
      if (!field) continue;
      if (field.type === 'checkbox') settings[key] = field.checked;
      else if (field.type === 'number') {
        const n = Math.round(Number(field.value));
        settings[key] = Number.isFinite(n) && n >= Number(field.min) ? Math.min(n, Number(field.max)) : before[key];
      } else settings[key] = field.value;
    }
    settings.location = draftLocation;
    saveSettings();

    // An idle timer picks up a new duration straight away.
    const phaseKey = PHASES[pomodoro.state.phase].setting;
    if (!pomodoro.state.running && settings[phaseKey] !== before[phaseKey]) pomodoro.state.remaining = pomodoro.duration();
    pomodoro.save();
    pomodoro.render();

    renderClock();
    renderAgenda();
    if (settings.units !== before.units || settings.location !== before.location) loadWeather();
    updateWakeLock();
  });
}

/* ---------------- Boot ---------------- */

function init() {
  pomodoro.init();
  initTodos();
  initSettings();

  renderClock();
  setInterval(renderClock, 1000);

  renderAgenda();
  loadAgenda();
  setInterval(loadAgenda, 5 * 60e3);

  loadWeather();
  setInterval(loadWeather, 15 * 60e3);

  $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
  updateWakeLock();
  document.addEventListener('visibilitychange', () => {
    updateWakeLock();
    if (document.visibilityState === 'visible') {
      renderClock();
      loadAgenda();
    }
  });
  // Wake lock requests need a user gesture on some browsers; retry on first tap.
  document.addEventListener('pointerdown', updateWakeLock, { once: true });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
