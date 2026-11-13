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

  renderDistribution(s);

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

// Today's distribution: one row per count, with a bar sized by how many
// students have that count and the emails underneath.
function renderDistribution(s) {
  const dist = s.distribution || [];
  $('dist-view').hidden = dist.length === 0;
  const list = $('dist');
  list.innerHTML = '';
  const most = Math.max(1, ...dist.map((d) => d.students));
  for (const d of dist) {
    const li = document.createElement('li');
    li.className = 'dist-row' + (d.count === s.mode ? ' is-mode' : '');

    const head = document.createElement('div');
    head.className = 'dist-head';
    const count = document.createElement('span');
    count.className = 'dist-count';
    count.textContent = d.count;
    const bar = document.createElement('span');
    bar.className = 'dist-bar';
    const fill = document.createElement('span');
    fill.style.width = `${(d.students / most) * 100}%`;
    bar.appendChild(fill);
    const n = document.createElement('span');
    n.className = 'dist-n';
    n.textContent = `${d.students} ${d.students === 1 ? 'student' : 'students'}${d.count === s.mode ? ' · mode' : ''}`;
    head.append(count, bar, n);

    const emails = document.createElement('ul');
    emails.className = 'dist-emails';
    for (const e of d.emails) {
      const chip = document.createElement('li');
      chip.textContent = e;
      if (e === s.email) chip.className = 'me';
      emails.appendChild(chip);
    }

    li.append(head, emails);
    list.appendChild(li);
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
