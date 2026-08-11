/*
 * Гейт-Worker перед "Картой продлений ОФД": проверяет логин/пароль (Basic Auth)
 * перед тем как отдать статику из ASSETS, плюс отдельная админка на /admin для
 * выдачи/отзыва доступа. Пароли пользователей хранятся в KV только как хэш
 * (PBKDF2-SHA256 + соль на каждого) — сам пароль нигде после выдачи не хранится.
 */

const PBKDF2_ITERATIONS = 20000;
const ADMIN_USERNAME = "admin";

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(bytesLen) {
  const bytes = new Uint8Array(bytesLen);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, Math.ceil(bytesLen * 1.3));
}

function generateUsername() {
  return "u" + randomToken(6).toLowerCase();
}

function generatePassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function pbkdf2(password, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

function bytesToB64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const derived = await pbkdf2(password, salt);
  return { saltB64: bytesToB64(salt), hashB64: bytesToB64(derived) };
}

async function verifyPassword(password, saltB64, hashB64) {
  const salt = b64ToBytes(saltB64);
  const derived = await pbkdf2(password, salt);
  const derivedB64 = bytesToB64(derived);
  return timingSafeEqual(derivedB64, hashB64);
}

function parseBasicAuth(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch (e) {
    return null;
  }
}

function unauthorized(realm) {
  return new Response("Требуется авторизация", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"` },
  });
}

async function requireAdmin(request, env) {
  const creds = parseBasicAuth(request);
  if (!creds) return false;
  if (!timingSafeEqual(creds.user, ADMIN_USERNAME)) return false;
  return timingSafeEqual(creds.pass, env.ADMIN_PASSWORD);
}

const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="ru"><head><meta charset="UTF-8">
<title>Админка — доступ к Карте продлений ОФД</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body{font-family:-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#111}
  h1{font-size:20px}
  table{width:100%;border-collapse:collapse;margin-top:16px}
  th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd;font-size:14px}
  input{padding:8px;border:1px solid #ccc;font-size:14px;width:260px}
  button{padding:8px 14px;font-size:14px;cursor:pointer;border:1px solid #333;background:#111;color:#fff}
  button.danger{background:#fff;color:#b00;border-color:#b00}
  .cred-box{background:#fffbe6;border:1px solid #e0c200;padding:12px;margin-top:12px;font-size:14px;display:none}
  .cred-box code{font-size:15px;font-weight:bold}
</style></head>
<body>
<h1>Доступ к инструменту — управление пользователями</h1>
<div>
  <input id="fio" placeholder="ФИО нового пользователя">
  <button onclick="createUser()">Создать доступ</button>
</div>
<div id="credBox" class="cred-box"></div>
<table id="usersTable"><thead><tr><th>ФИО</th><th>Логин</th><th>Создан</th><th></th></tr></thead><tbody></tbody></table>
<script>
async function loadUsers() {
  const res = await fetch("/admin/api/users");
  const data = await res.json();
  const tbody = document.querySelector("#usersTable tbody");
  tbody.innerHTML = "";
  data.users.forEach(u => {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td></td><td></td><td></td><td></td>";
    tr.children[0].textContent = u.fio;
    tr.children[1].textContent = u.username;
    tr.children[2].textContent = new Date(u.createdAt).toLocaleDateString("ru-RU");
    const btn = document.createElement("button");
    btn.textContent = "Отозвать";
    btn.className = "danger";
    btn.onclick = () => revokeUser(u.username);
    tr.children[3].appendChild(btn);
    tbody.appendChild(tr);
  });
}
async function createUser() {
  const fio = document.getElementById("fio").value.trim();
  if (!fio) return alert("Введи ФИО");
  const res = await fetch("/admin/api/users", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({fio}) });
  const data = await res.json();
  const box = document.getElementById("credBox");
  box.style.display = "block";
  box.innerHTML = "Логин: <code>" + data.username + "</code><br>Пароль: <code>" + data.password + "</code><br><small>Сохрани/перешли сейчас — повторно пароль не покажется.</small>";
  document.getElementById("fio").value = "";
  loadUsers();
}
async function revokeUser(username) {
  if (!confirm("Отозвать доступ у " + username + "?")) return;
  await fetch("/admin/api/users/" + username, { method: "DELETE" });
  loadUsers();
}
loadUsers();
</script>
</body></html>`;

async function handleAdmin(request, env, url) {
  if (!(await requireAdmin(request, env))) return unauthorized("Admin");

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    return new Response(ADMIN_PAGE_HTML, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
  }

  if (url.pathname === "/admin/api/users" && request.method === "GET") {
    const list = await env.OFD_USERS.list();
    const users = [];
    for (const key of list.keys) {
      const raw = await env.OFD_USERS.get(key.name);
      if (!raw) continue;
      const rec = JSON.parse(raw);
      users.push({ username: key.name, fio: rec.fio, createdAt: rec.createdAt });
    }
    users.sort((a, b) => b.createdAt - a.createdAt);
    return Response.json({ users });
  }

  if (url.pathname === "/admin/api/users" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const fio = (body.fio || "").toString().trim().slice(0, 200);
    if (!fio) return new Response("fio required", { status: 400 });
    const username = generateUsername();
    const password = generatePassword();
    const { saltB64, hashB64 } = await hashPassword(password);
    await env.OFD_USERS.put(username, JSON.stringify({ fio, saltB64, hashB64, createdAt: Date.now() }));
    return Response.json({ username, password });
  }

  const revokeMatch = url.pathname.match(/^\/admin\/api\/users\/([a-z0-9]+)$/);
  if (revokeMatch && request.method === "DELETE") {
    await env.OFD_USERS.delete(revokeMatch[1]);
    return Response.json({ ok: true });
  }

  return new Response("Not found", { status: 404 });
}

async function handleSite(request, env) {
  const creds = parseBasicAuth(request);
  if (!creds) return unauthorized("OFD Renewal Map");
  const raw = await env.OFD_USERS.get(creds.user);
  if (!raw) return unauthorized("OFD Renewal Map");
  const rec = JSON.parse(raw);
  const ok = await verifyPassword(creds.pass, rec.saltB64, rec.hashB64);
  if (!ok) return unauthorized("OFD Renewal Map");
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }
    return handleSite(request, env);
  },
};
