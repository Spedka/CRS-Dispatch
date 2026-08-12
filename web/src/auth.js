// Dispatch (office) auth — client side. Stores the device token + user in
// localStorage, patches fetch so every /api and /auth request carries the
// Bearer token (avoids editing every call in api.js), and exposes login/logout/
// change-password + a fire-and-forget usage tracker.

const TOKEN_KEY = 'dispatch_token';
const USER_KEY = 'dispatch_user'; // JSON: { name, email, isAdmin }

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const getUser = () => {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
};
export const isAdmin = () => !!getUser()?.isAdmin;

const setSession = (data) => {
  localStorage.setItem(TOKEN_KEY, data.token);
  localStorage.setItem(USER_KEY, JSON.stringify({ name: data.name, email: data.email, isAdmin: data.isAdmin }));
};

// Patch window.fetch ONCE so relative /api + /auth requests attach the token,
// and an expired/revoked token (401) drops the session and returns to login.
let patched = false;
export function installAuthFetch() {
  if (patched) return;
  patched = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    const guarded = url.startsWith('/api') || url.startsWith('/auth');
    const token = getToken();
    if (guarded && token) {
      init = { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } };
    }
    const res = await orig(input, init);
    // Session died out from under us (secret rotated / access revoked): clear
    // and reload to the login screen. Never do this for the login call itself.
    if (res.status === 401 && guarded && !url.includes('/auth/login') && getToken()) {
      logout();
      location.reload();
    }
    return res;
  };
}

export async function login(email, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error('Login failed. Try again.');
  setSession(await res.json());
  return true;
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function changePassword(password) {
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not change password');
}

// Fire-and-forget usage event. Never throws, never blocks the UI.
export function track(event, props, screen) {
  try {
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ event, screen: screen ?? null, props: props ?? null }),
    }).catch(() => {});
  } catch { /* ignore */ }
}
