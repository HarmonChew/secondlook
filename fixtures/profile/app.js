/* ENGINE_PROFILE_FIXTURE_V1: this file is intentionally small and deterministic. */
const PERSIST_PROFILE = false;
const ENABLE_UNITS = false;

const app = document.querySelector('#app');

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function readJson(path, options) {
  const response = await fetch(path, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const message = body && typeof body.error === 'string' ? body.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

function layout(title, description, content) {
  app.innerHTML = `<section class="shell"><p class="meta">Engine demo fixture</p><h1>${escapeText(title)}</h1><p>${escapeText(description)}</p>${content}</section>`;
}

async function renderProfile() {
  layout('Profile settings', 'Update the display name used by the application.', '<p>Loading your profile…</p>');
  try {
    const profile = await readJson('/api/profile');
    layout('Profile settings', 'Update the display name used by the application.', `
      <form data-testid="profile-form">
        <label for="display-name">Display name</label>
        <input id="display-name" data-testid="display-name" name="displayName" value="${escapeText(profile.displayName)}" autocomplete="off" />
        <button type="submit" data-testid="save-profile">Save</button>
        <p class="status" data-testid="save-status" aria-live="polite"></p>
      </form>
    `);
    const form = document.querySelector('[data-testid="profile-form"]');
    const input = document.querySelector('[data-testid="display-name"]');
    const status = document.querySelector('[data-testid="save-status"]');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.className = 'status';
      status.textContent = 'Saving…';
      try {
        if (PERSIST_PROFILE) {
          await readJson('/api/profile', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ displayName: input.value })
          });
        }
        status.className = 'status success';
        status.textContent = 'Saved successfully';
      } catch (error) {
        status.className = 'status error';
        status.textContent = error instanceof Error ? error.message : 'Could not save profile';
      }
    });
  } catch (error) {
    layout('Profile settings', 'Update the display name used by the application.', `<p class="error" data-testid="profile-error">${escapeText(error instanceof Error ? error.message : 'Could not load profile')}</p>`);
  }
}

async function renderUnits() {
  if (!ENABLE_UNITS) {
    layout('Organization units', 'This feature is not enabled in the current candidate.', '<p class="error" data-testid="units-disabled">Organization units are unavailable.</p>');
    return;
  }
  layout('Organization units', 'Browse the organization units available to your team.', `
    <div class="toolbar">
      <label for="unit-search">Search units</label>
      <input id="unit-search" data-testid="unit-search" placeholder="Name or code" autocomplete="off" />
    </div>
    <p class="status" data-testid="units-status" aria-live="polite">Loading units…</p>
    <ul class="unit-list" data-testid="unit-list"></ul>
    <div class="detail" data-testid="unit-detail" hidden></div>
  `);
  const search = document.querySelector('[data-testid="unit-search"]');
  const status = document.querySelector('[data-testid="units-status"]');
  const list = document.querySelector('[data-testid="unit-list"]');
  const detail = document.querySelector('[data-testid="unit-detail"]');
  try {
    const units = await readJson('/api/units');
    const draw = () => {
      const query = String(search.value || '').trim().toLowerCase();
      const filtered = units.filter((unit) => `${unit.code} ${unit.name}`.toLowerCase().includes(query));
      list.innerHTML = '';
      status.className = 'status';
      status.textContent = `${filtered.length} unit${filtered.length === 1 ? '' : 's'} found`;
      if (!filtered.length) {
        list.innerHTML = '<li class="empty" data-testid="units-empty">No organization units match this search.</li>';
        return;
      }
      filtered.forEach((unit) => {
        const item = document.createElement('li');
        item.className = 'unit-card';
        item.dataset.testid = 'unit-item';
        item.innerHTML = `<strong>${escapeText(unit.name)}</strong><div class="meta">${escapeText(unit.code)}</div><button type="button" data-testid="unit-details">View details</button>`;
        item.querySelector('button').addEventListener('click', () => {
          detail.hidden = false;
          detail.textContent = `${unit.name} · ${unit.description || 'No description provided.'}`;
        });
        list.appendChild(item);
      });
    };
    search.addEventListener('input', draw);
    draw();
  } catch (error) {
    status.className = 'status error';
    status.textContent = error instanceof Error ? error.message : 'Could not load units';
    list.innerHTML = '<li class="error" data-testid="units-error">Organization units could not be loaded.</li>';
  }
}

if (window.location.pathname === '/units') renderUnits();
else renderProfile();
