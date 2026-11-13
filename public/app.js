const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function render(s) {
  $('mode').textContent = s.mode;
  $('students').textContent = s.students;
  $('date').textContent = new Date(s.date + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });

  const signedIn = Boolean(s.email);
  $('login-view').hidden = signedIn;
  $('counter-view').hidden = !signedIn;
  if (signedIn) {
    $('who').textContent = s.email;
    $('mine').textContent = s.myCount;
  }

  $('history-view').hidden = s.history.length === 0;
  $('history').innerHTML = '';
  for (const h of s.history) {
    const tr = document.createElement('tr');
    for (const v of [h.date, h.mode, h.students]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    $('history').appendChild(tr);
  }
}

async function refresh() {
  try { render(await api('/api/state')); } catch { /* keep last view */ }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    render(await api('/api/login', { method: 'POST', body: JSON.stringify({ email: $('email').value }) }));
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => render(await api('/api/logout', { method: 'POST' })));

$('inc').addEventListener('click', async () => {
  $('mine').textContent = Number($('mine').textContent) + 1; // instant feedback
  if (navigator.vibrate) navigator.vibrate(15);
  try { render(await api('/api/increment', { method: 'POST' })); } catch { refresh(); }
});

$('dec').addEventListener('click', async () => {
  try { render(await api('/api/decrement', { method: 'POST' })); } catch { refresh(); }
});

refresh();
setInterval(refresh, 3000); // keep the class total live
