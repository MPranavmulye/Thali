/*
 * Thali phone shim — runs the Thali app with no server.
 *   db / assets  -> IndexedDB on this phone
 *   sample (AI)  -> calls Gemini, Groq, OpenRouter directly with YOUR free keys
 *                   (stored only on this phone), falling back in order
 *   downloads    -> normal browser download
 * The app file itself is the same as the Claude artifact.
 */
(function () {
  "use strict";

  /* ---------------- IndexedDB ---------------- */
  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("thali", 1);
      r.onupgradeneeded = () => { const d = r.result; ["docs", "assets", "settings"].forEach(s => d.objectStoreNames.contains(s) || d.createObjectStore(s)); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await openDB();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      let out; const rq = fn(s); if (rq) rq.onsuccess = () => { out = rq.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const SEP = "\u0001";
  const range = col => IDBKeyRange.bound(col + SEP, col + "\u0002", false, true);
  const idbErr = e => ({ code: "unavailable", message: "Couldn't save on this phone: " + (e && e.message || e) });

  /* ---------------- db capability ---------------- */
  const listeners = new Set();
  function snapshot(rows) {
    const docs = rows.map(r => ({ id: r.id, exists: true, data: () => r.data, metadata: { fromCache: false, hasPendingWrites: false } }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })) };
  }
  const load = col => tx("docs", "readonly", s => s.getAll(range(col))).then(v => v || []);
  async function refresh(l) { try { l.next(snapshot(await load(l.col))); } catch (e) { l.err && l.err(idbErr(e)); } }
  const notify = col => listeners.forEach(l => { if (l.col === col) refresh(l); });

  function docRef(col, id) {
    const key = col + SEP + id;
    return {
      id, path: col + "/" + id,
      async get() { const v = await tx("docs", "readonly", s => s.get(key)); return { id, exists: !!v, data: () => v && v.data, metadata: { fromCache: false, hasPendingWrites: false } }; },
      async set(data) { try { await tx("docs", "readwrite", s => s.put({ id, data: JSON.parse(JSON.stringify(data)) }, key)); } catch (e) { throw idbErr(e); } notify(col); },
      async update(data) { const cur = await tx("docs", "readonly", s => s.get(key)); if (!cur) throw { code: "not_found", message: "Not found" }; await this.set({ ...cur.data, ...data }); },
      async delete() { await tx("docs", "readwrite", s => s.delete(key)); notify(col); },
      onSnapshot(next, err) {
        const l = { col, next: snap => { const d = snap.docs.find(x => x.id === id); next(d || { id, exists: false, data: () => undefined, metadata: {} }); }, err };
        listeners.add(l); refresh(l); return () => listeners.delete(l);
      },
      collection: sub => collection(col + "/" + id + "/" + sub),
    };
  }
  function collection(col) {
    const q = {
      path: col,
      where() { return q; }, orderBy() { return q; }, limit() { return q; },
      async get() { return snapshot(await load(col)); },
      onSnapshot(next, err) { const l = { col, next, err }; listeners.add(l); refresh(l); return () => listeners.delete(l); },
      doc(id) { return docRef(col, id || ("a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7))); },
      async add(data) { const r = q.doc(); await r.set(data); return r; },
    };
    return q;
  }
  const db = { collection, doc(p) { const i = p.lastIndexOf("/"); return docRef(p.slice(0, i), p.slice(i + 1)); } };

  /* ---------------- assets (photos, served by sw.js) ---------------- */
  const assets = {
    async upload(blob) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { await tx("assets", "readwrite", s => s.put({ blob, type: blob.type || "image/jpeg" }, id)); } catch (e) { throw idbErr(e); }
      return { id, url: "assets/" + id, sizeBytes: blob.size, contentType: blob.type };
    },
    list: async () => ({ assets: [], usage: {} }),
    delete: id => tx("assets", "readwrite", s => s.delete(id)),
  };

  /* ---------------- settings (AI keys) ---------------- */
  const DEFAULTS = {
    order: "gemini,groq,openrouter",
    gemini_key: "", groq_key: "", openrouter_key: "",
    gemini_model: "gemini-3.8-flash", gemini_quick: "gemini-3.5-flash-lite",
    groq_model: "qwen/qwen3.8-27b", openrouter_model: "openrouter/free",
  };
  let settings = { ...DEFAULTS };
  const settingsReady = tx("settings", "readonly", s => s.get("ai")).then(v => { settings = { ...DEFAULTS, ...(v || {}) }; }).catch(() => {});
  const saveSettings = v => { settings = { ...DEFAULTS, ...v }; return tx("settings", "readwrite", s => s.put(settings, "ai")); };
  const keyFor = p => settings[p + "_key"];

  /* ---------------- AI providers ---------------- */
  const MAXTOK = 8192;
  class PErr extends Error { constructor(m, code) { super(m); this.code = code || "unavailable"; } }
  async function post(url, headers, body, name) {
    let r;
    const ctl = new AbortController(); const tmo = setTimeout(() => ctl.abort(), 120000);
    try { r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctl.signal }); }
    catch (e) { throw new PErr(`${name}: couldn't connect${e.name === "AbortError" ? " (timed out)" : ""}`); }
    finally { clearTimeout(tmo); }
    if (r.ok) return r.json();
    const txt = (await r.text().catch(() => "")).slice(0, 200);
    if (r.status === 429) throw new PErr(`${name}: free limit reached for now`, "rate_limited");
    if (r.status === 401 || r.status === 403) throw new PErr(`${name}: key not accepted — check it in AI keys`);
    if (r.status === 404) throw new PErr(`${name}: model not found — update the model name in AI keys`);
    throw new PErr(`${name}: error ${r.status} ${txt}`);
  }
  async function gemini(msgs, images, tier, json) {
    const model = tier === "quick" ? settings.gemini_quick : settings.gemini_model;
    const contents = msgs.map((m, i) => ({ role: m.role === "assistant" ? "model" : "user",
      parts: (i === msgs.length - 1 ? images.map(im => ({ inline_data: { mime_type: im.media_type, data: im.data } })) : []).concat([{ text: m.content }]) }));
    const cfg = { maxOutputTokens: MAXTOK, temperature: 0.2 }; if (json) cfg.responseMimeType = "application/json";
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { "x-goog-api-key": keyFor("gemini") }, { contents, generationConfig: cfg }, "Gemini");
    const c = (j.candidates || [{}])[0];
    const text = ((c.content || {}).parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
    if (!text) throw new PErr(`Gemini returned no answer (${c.finishReason || "unknown"})`);
    return { text, truncated: c.finishReason === "MAX_TOKENS", model };
  }
  async function chat(url, key, name, model, msgs, images, json, jsonMode, extra) {
    const messages = msgs.map((m, i) => (m.role === "user" && i === msgs.length - 1 && images.length)
      ? { role: "user", content: [{ type: "text", text: m.content }].concat(images.map(im => ({ type: "image_url", image_url: { url: `data:${im.media_type};base64,${im.data}` } }))) }
      : { role: m.role, content: m.content });
    const body = { model, messages, max_tokens: MAXTOK, temperature: 0.2 };
    if (json && jsonMode) body.response_format = { type: "json_object" };
    const j = await post(url, { Authorization: "Bearer " + key, ...(extra || {}) }, body, name);
    const ch = (j.choices || [{}])[0]; let text = (ch.message || {}).content || "";
    if (Array.isArray(text)) text = text.map(p => p.text || "").join("");
    if (!text) throw new PErr(`${name} returned no answer`);
    return { text, truncated: ch.finish_reason === "length", model };
  }
  const PROVIDERS = {
    gemini,
    groq: (m, im, t, j) => chat("https://api.groq.com/openai/v1/chat/completions", keyFor("groq"), "Groq", settings.groq_model, m, im, j, true),
    openrouter: (m, im, t, j) => chat("https://openrouter.ai/api/v1/chat/completions", keyFor("openrouter"), "OpenRouter", settings.openrouter_model, m, im, j, false,
      { "X-Title": "Thali Calorie Tracker", "HTTP-Referer": location.origin }),
  };
  const chain = () => settings.order.split(",").map(s => s.trim().toLowerCase()).filter(p => PROVIDERS[p] && keyFor(p));

  function blobToB64(b) { return new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(",")[1]); f.onerror = rej; f.readAsDataURL(b); }); }
  async function ask(input, opts, json) {
    await settingsReady;
    opts = opts || {};
    const list = chain();
    if (!list.length) { setTimeout(openSettings, 50); throw { code: "not_configured", message: "Add a free AI key first: ☰ menu → AI keys." }; }
    const msgs = typeof input === "string" ? [{ role: "user", content: input }] : input.map(m => ({ role: m.role, content: String(m.content) }));
    const images = [];
    for (const b of opts.images || []) images.push({ media_type: b.type || "image/jpeg", data: await blobToB64(b) });
    const errs = [];
    for (const p of list) {
      try {
        const r = await PROVIDERS[p](msgs, images, opts.modelTier || "default", json);
        if (json && r.truncated) throw new PErr(`${p}: answer was cut short`);
        lastUsed = { provider: p, model: r.model, at: new Date().toLocaleString(), failed: errs.slice() };
        if (opts.onText) try { opts.onText({ text: r.text, delta: r.text }); } catch (_) {}
        return r;
      } catch (e) { errs.push(e.message || String(e)); }
    }
    const allLimits = errs.every(e => /limit/.test(e));
    throw { code: allLimits ? "rate_limited" : "unavailable", message: "All AI providers failed. " + errs.join(" · ") };
  }
  let lastUsed = null;
  function parseTolerant(text) {
    const t = String(text || "").trim();
    try { return JSON.parse(t); } catch (_) {}
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch (_) {} }
    const a = t.search(/[\[{]/), z = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch (_) {} }
    throw { code: "invalid_json", message: "The AI answer wasn't in the expected format.", text: t };
  }
  async function sample(input, opts) { const r = await ask(input, opts, false); return { text: r.text, truncated: r.truncated }; }
  sample.json = async (input, opts) => parseTolerant((await ask(input, opts, true)).text);
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 3, maxInputBytes: 15 * 1024 * 1024, mediaTypes: ["image/jpeg", "image/png", "image/webp"] } });

  /* ---------------- user / downloads ---------------- */
  const user = { id: async () => "local", me: async () => ({ id: "local", name: "You" }), isOwner: () => true, canEdit: () => true, can: () => true,
    profiles: async ids => Object.fromEntries((ids || []).map(i => [i, { id: i, name: "You" }])), search: async () => [] };
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const u = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = u; a.download = filename || "download"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 5000);
      return { status: "saved" };
    },
  };

  /* ---------------- AI keys screen ---------------- */
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null) continue; if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    kids.forEach(c => c != null && e.append(c)); return e;
  }
  async function openSettings() {
    await settingsReady;
    if (document.getElementById("thali-keys")) return;
    const inputs = {};
    const keyRow = (p, label, url, hint) => {
      const inp = el("input", { class: "inp", id: "k-" + p, type: "password", autocomplete: "off", spellcheck: "false", placeholder: "Paste key" });
      inp.value = settings[p + "_key"] || ""; inputs[p + "_key"] = inp;
      const show = el("button", { class: "btn", type: "button", text: "Show", onclick: () => { inp.type = inp.type === "password" ? "text" : "password"; show.textContent = inp.type === "password" ? "Show" : "Hide"; } });
      const status = el("div", { class: "small muted", id: "st-" + p });
      return el("div", { class: "stack", style: "gap:6px" },
        el("label", { class: "field", for: "k-" + p, text: label }),
        el("div", { style: "display:flex;gap:6px" }, inp, show),
        el("div", { class: "small muted", text: hint + " Get one at " + url }), status);
    };
    const adv = {};
    const advRow = (k, label) => { const i = el("input", { class: "inp", id: "a-" + k }); i.value = settings[k]; adv[k] = i; return el("label", { class: "field", for: "a-" + k, text: label }, i); };
    const msg = el("div", { class: "small", role: "status" });
    const collect = () => { const v = { ...settings }; Object.entries(inputs).forEach(([k, i]) => v[k] = i.value.trim()); Object.entries(adv).forEach(([k, i]) => v[k] = i.value.trim() || DEFAULTS[k]); return v; };
    const testBtn = el("button", { class: "btn soft", type: "button", text: "Test keys" });
    testBtn.onclick = async () => {
      const v = collect(); const prev = settings; settings = v; testBtn.disabled = true;
      for (const p of ["gemini", "groq", "openrouter"]) {
        const st = document.getElementById("st-" + p);
        if (!v[p + "_key"]) { st.textContent = "No key"; st.style.color = ""; continue; }
        st.textContent = "Testing…"; st.style.color = "";
        try { await PROVIDERS[p]([{ role: "user", content: 'Reply with only {"ok":true}' }], [], "quick", true); st.textContent = "✓ Working"; st.style.color = "var(--green)"; }
        catch (e) { st.textContent = "✗ " + e.message; st.style.color = "var(--pink)"; }
      }
      settings = prev; testBtn.disabled = false;
    };
    const saveBtn = el("button", { class: "btn pri", type: "button", text: "Save" });
    saveBtn.onclick = async () => { await saveSettings(collect()); close(); toastMsg(chain().length ? "AI keys saved" : "Saved — add at least one key to use AI"); };
    const close = () => document.getElementById("thali-keys")?.remove();
    const used = lastUsed ? `Last answer came from ${lastUsed.provider} (${lastUsed.model}) at ${lastUsed.at}.` : "";
    const sc = el("div", { class: "scrim", id: "thali-keys", style: "z-index:35", onclick: e => { if (e.target === sc) close(); } },
      el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "AI keys" },
        el("div", { class: "sheet-h" }, el("h2", { class: "h3", text: "AI keys" }), el("button", { class: "btn", type: "button", text: "Close", onclick: close })),
        el("div", { class: "stack" },
          el("p", { class: "muted small", style: "margin:0", text: "Free keys, no card needed. You need at least one; with more, the app switches automatically when a free limit runs out. Keys are stored only on this phone." }),
          keyRow("gemini", "1. Google Gemini (main)", "aistudio.google.com/apikey", "Best for food photos."),
          keyRow("groq", "2. Groq (backup)", "console.groq.com/keys", ""),
          keyRow("openrouter", "3. OpenRouter (backup)", "openrouter.ai/settings/keys", ""),
          el("details", {}, el("summary", { class: "small", text: "Advanced: order and model names" }),
            el("div", { class: "stack", style: "margin-top:10px" }, advRow("order", "Order (comma separated)"), advRow("gemini_model", "Gemini model"), advRow("gemini_quick", "Gemini quick model"),
              advRow("groq_model", "Groq model"), advRow("openrouter_model", "OpenRouter model"))),
          el("p", { class: "small muted", style: "margin:0", text: "Free tiers may use what you send to improve their models. Your log itself stays on this phone — back it up from ☰ → Backup & restore every week or so. " + used }),
          msg),
        el("div", { class: "btns" }, testBtn, saveBtn)));
    document.body.appendChild(sc);
  }
  function toastMsg(m) { const t = el("div", { class: "toast", role: "status", text: m }); document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }

  /* ---------------- boot ---------------- */
  window.thaliHost = { openSettings, storageNote: "Your log is stored on this phone. Back it up regularly." };
  const caps = { db, sample, user, assets, downloads };
  window.claude = Object.freeze({ use: async name => caps[name] || null });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  settingsReady.then(() => { if (!chain().length) setTimeout(openSettings, 900); });
})();
