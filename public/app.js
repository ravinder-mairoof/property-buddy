// Overrides the template's mock executeSearch with live data from /api/property
const $ = (id) => document.getElementById(id);
const gbp = (n) => '£' + Number(n).toLocaleString('en-GB');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function executeSearch() {
  const q = $('searchInput').value.trim();
  if (!q) return;
  showToast('Looking up property data...', 'fa-magnifying-glass');
  try {
    const r = await fetch('/api/property?q=' + encodeURIComponent(q));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    $('activePropertyTitle').textContent = q;
    $('propMeta').textContent = [d.location.district, d.location.region, d.location.postcode].filter(Boolean).join(' • ');
    $('priceLabel').textContent = 'Median sold nearby (2 yrs)';
    $('priceValue').textContent = d.medianSold ? gbp(d.medianSold) : 'No sales found';
    $('compsBody').innerHTML = d.sales.length ? d.sales.map((s) => `
      <tr class="hover:bg-slate-50"><td class="p-3 font-semibold text-slate-900">${esc(s.address)}<div class="font-normal text-slate-400">${esc(s.postcode)}</div></td>
      <td class="p-3 font-bold text-slate-900">${gbp(s.price)}</td><td class="p-3">${esc(s.type || '-')}</td>
      <td class="p-3">${esc(s.date)}</td></tr>`).join('')
      : '<tr><td class="p-3" colspan="4">No recent sales found within about 500m.</td></tr>';
    if (d.crimeLocked) { $('crimeCount').textContent = 'Subscribed tier'; $('crimeText').textContent = 'Upgrade to see nearby recorded crime.'; }
    else if (d.crime) {
      $('crimeCount').textContent = d.crime.total + ' crimes';
      $('crimeText').textContent = `Recorded within about 1 mile in ${d.crime.month}. Most common: ` +
        d.crime.top.map((t) => `${t.category.replace(/-/g, ' ')} (${t.count})`).join(', ') + '.';
    } else { $('crimeCount').textContent = 'Unavailable'; $('crimeText').textContent = 'Police data could not be loaded.'; }
    const e = d.epc || {};
    const set = (id, v) => ($(id).textContent = v || '-');
    set('specArea', e.floorAreaM2 && e.floorAreaM2 + ' m²'); set('specRating', e.rating && e.rating + (e.score ? ` (${e.score})` : ''));
    set('specType', [e.builtForm, e.propertyType].filter(Boolean).join(' ')); set('specAge', e.ageBand);
    $('specNote').textContent = e.address ? 'Energy certificate: ' + e.address + (e.lodged ? ' (lodged ' + String(e.lodged).slice(0, 10) + ')' : '')
      : e.error ? 'Energy certificate unavailable: ' + e.error + '.'
      : e.candidates ? 'No exact match among ' + e.candidates + ' certificates here. Include the house number and street.'
      : 'Search a full address and postcode to load the energy certificate.';
    showToast('Loaded data for ' + d.location.postcode, 'fa-circle-check');
  } catch (e) { showToast(e.message, 'fa-triangle-exclamation'); }
}

// ---------------- Auth, tiers and billing ----------------
state.tier = 'basic'; state.user = null; state.billing = false;
let authMode = 'register';
const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
};
async function refreshMe() {
  const d = await api('/api/me');
  state.user = d.user; state.billing = d.billing; state.tier = d.user?.tier || 'basic';
  updateTierBadgeUI();
}
function toggleAuthMode(force) {
  authMode = force || (authMode === 'register' ? 'login' : 'register');
  const reg = authMode === 'register';
  $('nameField').classList.toggle('hidden', !reg); $('authName').required = reg;
  $('authTitle').textContent = reg ? 'Create your account' : 'Sign in';
  $('authSubmit').textContent = reg ? 'Create account' : 'Sign in';
  $('authToggle').textContent = reg ? 'I already have an account' : 'Create a new account';
  $('authPass').autocomplete = reg ? 'new-password' : 'current-password';
}
function openAuthModal() {
  const u = state.user;
  $('authForm').classList.toggle('hidden', !!u); $('accountPane').classList.toggle('hidden', !u);
  if (u) { $('accName').textContent = u.name; $('accEmail').textContent = u.email; $('accTier').textContent = u.tier === 'subscribed' ? 'Subscribed' : 'Basic'; $('authTitle').textContent = 'Your account'; }
  else toggleAuthMode(authMode);
  $('authModal').classList.remove('hidden');
}
async function handleAuthSubmit(e) {
  e.preventDefault();
  $('authError').classList.add('hidden');
  try {
    await api('/api/auth/' + authMode, { name: $('authName').value, email: $('authEmail').value, password: $('authPass').value });
    $('authPass').value = ''; await refreshMe(); closeAuthModal();
    showToast(authMode === 'register' ? 'Account created.' : 'Signed in.', 'fa-user-check');
  } catch (err) { $('authError').textContent = err.message; $('authError').classList.remove('hidden'); }
}
async function logout() { await api('/api/auth/logout', {}); await refreshMe(); closeAuthModal(); showToast('Signed out.', 'fa-right-from-bracket'); }
async function switchUserTier(tier) {
  try {
    if (!state.user) { closeSubscriptionModal(); openAuthModal(); return; }
    if (tier === 'subscribed' && state.tier !== 'subscribed') {
      if (state.billing) return (location.href = (await api('/api/billing/checkout', {})).url);
      await api('/api/dev/tier', { tier });                 // local testing only (no Stripe configured)
    } else if (tier === 'basic' && state.tier === 'subscribed') {
      if (state.billing) return (location.href = (await api('/api/billing/portal', {})).url);
      await api('/api/dev/tier', { tier });
    }
    await refreshMe(); closeSubscriptionModal();
  } catch (err) { showToast(err.message, 'fa-triangle-exclamation'); }
}
const baseSwitchTab = switchTab;
window.switchTab = function (t) {
  if (state.tier !== 'subscribed' && ['condition', 'demographics'].includes(t)) { openSubscriptionModal(); return; }
  baseSwitchTab(t);
};
document.addEventListener('DOMContentLoaded', async () => {
  await refreshMe().catch(() => {});
  if (new URLSearchParams(location.search).has('upgraded')) { showToast('Thanks! Your plan will update in a moment.', 'fa-crown'); history.replaceState({}, '', '/'); }
});
