"use strict";
/**
 * Application "Inventaire Magasin" — app web autonome (aucune dépendance,
 * aucun réseau requis). Stockage IndexedDB (db.js), export xlsx/csv (xlsx.js).
 */

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const DIACRITICS = {
  "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a",
  "À": "A", "Á": "A", "Â": "A", "Ã": "A", "Ä": "A", "Å": "A",
  "ç": "c", "Ç": "C",
  "è": "e", "é": "e", "ê": "e", "ë": "e",
  "È": "E", "É": "E", "Ê": "E", "Ë": "E",
  "ì": "i", "í": "i", "î": "i", "ï": "i",
  "Ì": "I", "Í": "I", "Î": "I", "Ï": "I",
  "ñ": "n", "Ñ": "N",
  "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o",
  "Ò": "O", "Ó": "O", "Ô": "O", "Õ": "O", "Ö": "O",
  "ù": "u", "ú": "u", "û": "u", "ü": "u",
  "Ù": "U", "Ú": "U", "Û": "U", "Ü": "U",
  "ý": "y", "ÿ": "y", "Ý": "Y",
  "œ": "oe", "Œ": "OE", "æ": "ae", "Æ": "AE",
};

function slugify(input) {
  const noDiacritics = String(input)
    .split("")
    .map((ch) => DIACRITICS[ch] ?? ch)
    .join("");
  return noDiacritics.replace(/[^a-zA-Z0-9]/g, "");
}

function pad2(n) { return String(n).padStart(2, "0"); }

function toUiDate(isoDate) {
  if (!isoDate) return "";
  const d = new Date(isoDate);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function toFileDate(isoDate) {
  const d = new Date(isoDate);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function nowIso() { return new Date().toISOString(); }

function todayInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

const ETAT_LABELS = { BON: "Bon", ENDOMMAGE: "Endommagé", A_VERIFIER: "À vérifier" };

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---------------------------------------------------------------------------
// Confirmation (modale maison — le window.confirm() natif rend une UX
// incohérente avec le thème de l'app, et certains navigateurs/environnements
// le désactivent purement et simplement).
// ---------------------------------------------------------------------------

function showConfirm(message, { confirmLabel = "Confirmer", cancelLabel = "Annuler", danger = false } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal-sheet">
        <p class="card-title">${escapeHtml(message)}</p>
        <div class="btn-row">
          <button class="big-btn secondary" id="confirm-cancel">${escapeHtml(cancelLabel)}</button>
          <button class="big-btn ${danger ? "danger" : ""}" id="confirm-ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const cleanup = (result) => { backdrop.remove(); resolve(result); };
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cleanup(false); });
    backdrop.querySelector("#confirm-cancel").addEventListener("click", () => cleanup(false));
    backdrop.querySelector("#confirm-ok").addEventListener("click", () => cleanup(true));
  });
}

// ---------------------------------------------------------------------------
// Thème
// ---------------------------------------------------------------------------

async function initTheme() {
  const pref = await DB.get("preferences", "theme");
  const theme = pref ? pref.valeur : "clair";
  document.documentElement.dataset.theme = theme;
  document.getElementById("btn-theme").textContent = theme === "sombre" ? "☀️" : "🌙";
}

async function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  const next = current === "sombre" ? "clair" : "sombre";
  document.documentElement.dataset.theme = next;
  document.getElementById("btn-theme").textContent = next === "sombre" ? "☀️" : "🌙";
  await DB.put("preferences", { cle: "theme", valeur: next });
}

// ---------------------------------------------------------------------------
// Accès données métier
// ---------------------------------------------------------------------------

async function listInventories() {
  const all = await DB.getAll("inventaires");
  return all.sort((a, b) => (b.dateCreation || "").localeCompare(a.dateCreation || ""));
}

async function createInventory({ magasin, site, zone, dateInventaire, operateur }) {
  const numero = await nextNumeroInventaire(new Date(dateInventaire));
  const record = {
    numero, magasin, site, zone, dateInventaire, operateur,
    statut: "EN_COURS",
    dateCreation: nowIso(),
    dateCloture: null,
  };
  const id = await DB.add("inventaires", record);
  return { ...record, id };
}

async function updateInventory(inv) {
  const current = await DB.get("inventaires", inv.id);
  if (!current) throw new Error("Inventaire introuvable.");
  if (current.statut === "CLOTURE") throw new Error("Cet inventaire est clôturé.");
  await DB.put("inventaires", inv);
}

async function closeInventory(id) {
  const inv = await DB.get("inventaires", id);
  if (!inv) throw new Error("Inventaire introuvable.");
  inv.statut = "CLOTURE";
  inv.dateCloture = nowIso();
  await DB.put("inventaires", inv);
  return inv;
}

async function deleteInventoryCascade(id) {
  const lines = await DB.getAllByIndex("lignes", "inventaireId", id);
  for (const line of lines) await DB.delete("lignes", line.id);
  await DB.delete("inventaires", id);
}

async function listLines(inventoryId) {
  const all = await DB.getAllByIndex("lignes", "inventaireId", inventoryId);
  return all.sort((a, b) => a.ordre - b.ordre);
}

async function nextOrdre(inventoryId) {
  const lines = await listLines(inventoryId);
  return lines.reduce((max, l) => Math.max(max, l.ordre || 0), 0) + 1;
}

async function addLine(data) {
  const ordre = await nextOrdre(data.inventaireId);
  const record = { ...data, ordre, dateSaisie: nowIso() };
  const id = await DB.add("lignes", record);
  return { ...record, id };
}

async function updateLine(line) {
  await DB.put("lignes", line);
}

async function deleteLine(id) {
  await DB.delete("lignes", id);
}

async function duplicateLine(line) {
  const ordre = await nextOrdre(line.inventaireId);
  const copy = { ...line, ordre, dateSaisie: nowIso() };
  // La propriété "id" doit être absente (pas juste `undefined`) pour que
  // IndexedDB génère une nouvelle clé auto-incrémentée — sinon
  // add() échoue avec "key path yielded a value that is not a valid key".
  delete copy.id;
  const id = await DB.add("lignes", copy);
  return { ...copy, id };
}

// ---------------------------------------------------------------------------
// Navigation (pile simple, pas d'API history — app locale)
// ---------------------------------------------------------------------------

let navStack = [];
let current = { view: "home", params: {} };

function navigate(view, params = {}, { replace = false } = {}) {
  if (!replace) navStack.push(current);
  current = { view, params };
  render();
}

function goBack() {
  const prev = navStack.pop();
  if (prev) {
    current = prev;
    render();
  } else {
    navigate("home", {}, { replace: true });
  }
}

function goHome() {
  navStack = [];
  current = { view: "home", params: {} };
  render();
}

// ---------------------------------------------------------------------------
// Rendu racine
// ---------------------------------------------------------------------------

const root = () => document.getElementById("app-root");
const title = () => document.getElementById("app-title");
const backBtn = () => document.getElementById("btn-back");

function setHeader(text, showBack) {
  title().textContent = text;
  backBtn().hidden = !showBack;
}

// Compteur de génération : chaque render() incrémente ce compteur et capture
// sa propre valeur. Les fonctions d'écran vérifient `isStale()` après chaque
// `await` qui précède une écriture DOM, pour ne jamais laisser un rendu
// obsolète (ex. navigation déclenchée par un double-tap rapide) modifier un
// DOM qui appartient déjà à un écran suivant — évite les
// "Cannot read properties of null" aléatoires observés en test.
let renderGeneration = 0;

async function render() {
  const myGen = ++renderGeneration;
  const isStale = () => myGen !== renderGeneration;
  window.scrollTo(0, 0);
  switch (current.view) {
    case "home": return renderHome(isStale);
    case "inventoryForm": return renderInventoryForm(current.params, isStale);
    case "inventoryDetail": return renderInventoryDetail(current.params, isStale);
    case "articleForm": return renderArticleForm(current.params, isStale);
    case "closure": return renderClosure(current.params, isStale);
    default: return renderHome(isStale);
  }
}

// ---------------------------------------------------------------------------
// Écran : Accueil
// ---------------------------------------------------------------------------

async function renderHome(isStale = () => false) {
  setHeader("Inventaire Magasin", false);
  const inventories = await listInventories();
  if (isStale()) return;

  if (inventories.length === 0) {
    root().innerHTML = `
      <div class="empty-state">
        <span class="emoji">📦</span>
        <p>Aucun inventaire pour le moment.<br>Appuyez sur « Nouvel inventaire » pour commencer.</p>
      </div>
      <div class="fab-row"><button class="big-btn" id="btn-new-inv">+ Nouvel inventaire</button></div>
    `;
  } else {
    const cards = inventories.map((inv) => cardInventoryHtml(inv)).join("");
    root().innerHTML = `
      <div id="inv-list">${cards}</div>
      <div class="fab-row"><button class="big-btn" id="btn-new-inv">+ Nouvel inventaire</button></div>
    `;
  }

  document.getElementById("btn-new-inv").addEventListener("click", () => navigate("inventoryForm", {}));

  root().querySelectorAll("[data-open]").forEach((el) => {
    el.addEventListener("click", () => navigate("inventoryDetail", { id: Number(el.dataset.open) }));
  });
  root().querySelectorAll("[data-edit]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      navigate("inventoryForm", { id: Number(el.dataset.edit) });
    });
  });
  root().querySelectorAll("[data-delete]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = Number(el.dataset.delete);
      const ok = await showConfirm(
        "Supprimer définitivement cet inventaire et toutes ses lignes ?",
        { confirmLabel: "Supprimer", danger: true }
      );
      if (ok) {
        await deleteInventoryCascade(id);
        showToast("Inventaire supprimé.");
        renderHome();
      }
    });
  });
}

function cardInventoryHtml(inv) {
  const estCloture = inv.statut === "CLOTURE";
  return `
    <div class="card" data-open="${inv.id}" style="cursor:pointer;">
      <div class="card-row">
        <span class="card-title">${escapeHtml(inv.numero)}</span>
        <span class="badge ${estCloture ? "cloture" : "en-cours"}">${estCloture ? "Clôturé" : "En cours"}</span>
      </div>
      <p class="card-sub">${escapeHtml(inv.magasin)} — ${escapeHtml(inv.zone)}</p>
      <p class="card-sub">Site : ${escapeHtml(inv.site)}</p>
      <p class="card-sub">${toUiDate(inv.dateInventaire)} · ${escapeHtml(inv.operateur)}</p>
      <div class="card-actions">
        ${estCloture ? "" : `<button class="icon-btn" data-edit="${inv.id}" title="Modifier">✏️</button>`}
        <button class="icon-btn" data-delete="${inv.id}" title="Supprimer">🗑️</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Écran : Formulaire inventaire (création / modification)
// ---------------------------------------------------------------------------

async function renderInventoryForm({ id }, isStale = () => false) {
  const existing = id ? await DB.get("inventaires", id) : null;
  if (isStale()) return;
  const estCloture = existing && existing.statut === "CLOTURE";
  setHeader(existing ? "Modifier l'inventaire" : "Nouvel inventaire", true);

  root().innerHTML = `
    <form id="inv-form">
      ${existing
        ? `<p class="readonly-note">Numéro d'inventaire : <strong>${escapeHtml(existing.numero)}</strong></p>`
        : `<p class="readonly-note">Le numéro d'inventaire sera généré automatiquement.</p>`}
      ${estCloture ? `<p class="readonly-note" style="color:var(--danger)">Cet inventaire est clôturé : modification impossible.</p>` : ""}
      <div class="form-grid">
        <div class="full">
          <label for="f-magasin">Magasin *</label>
          <input type="text" id="f-magasin" required value="${escapeHtml(existing?.magasin ?? "")}" ${estCloture ? "disabled" : ""} />
        </div>
        <div>
          <label for="f-site">Site *</label>
          <input type="text" id="f-site" required value="${escapeHtml(existing?.site ?? "")}" ${estCloture ? "disabled" : ""} />
        </div>
        <div>
          <label for="f-zone">Zone / secteur *</label>
          <input type="text" id="f-zone" required value="${escapeHtml(existing?.zone ?? "")}" ${estCloture ? "disabled" : ""} />
        </div>
        <div>
          <label for="f-operateur">Opérateur *</label>
          <input type="text" id="f-operateur" required value="${escapeHtml(existing?.operateur ?? "")}" ${estCloture ? "disabled" : ""} />
        </div>
        <div>
          <label for="f-date">Date de l'inventaire *</label>
          <input type="date" id="f-date" required value="${existing?.dateInventaire ?? todayInputValue()}" ${estCloture ? "disabled" : ""} />
        </div>
      </div>
      ${estCloture ? "" : `<div class="btn-row"><button type="submit" class="big-btn">💾 Enregistrer</button></div>`}
    </form>
  `;

  backBtn().onclick = goBack;

  if (estCloture) return;

  document.getElementById("inv-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = {
      magasin: document.getElementById("f-magasin").value.trim(),
      site: document.getElementById("f-site").value.trim(),
      zone: document.getElementById("f-zone").value.trim(),
      operateur: document.getElementById("f-operateur").value.trim(),
      dateInventaire: document.getElementById("f-date").value,
    };
    if (!data.magasin || !data.site || !data.zone || !data.operateur || !data.dateInventaire) {
      showToast("Merci de remplir tous les champs obligatoires.");
      return;
    }
    try {
      if (existing) {
        await updateInventory({ ...existing, ...data });
        showToast("Inventaire mis à jour.");
      } else {
        await createInventory(data);
        showToast("Inventaire créé.");
      }
      goBack();
    } catch (err) {
      showToast("Erreur : " + err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Écran : Détail inventaire (lignes, recherche/tri, récap, actions)
// ---------------------------------------------------------------------------

let detailState = { search: "", sortMode: "date", inventoryId: null };

async function renderInventoryDetail({ id }, isStale = () => false) {
  const inv = await DB.get("inventaires", id);
  if (isStale()) return;
  if (!inv) { goHome(); return; }
  if (detailState.inventoryId !== id) {
    detailState = { search: "", sortMode: "date", inventoryId: id };
  }
  const estCloture = inv.statut === "CLOTURE";
  setHeader(inv.numero, true);
  backBtn().onclick = goHome;

  root().innerHTML = `
    <div class="card">
      <div class="card-row">
        <span class="card-title">${escapeHtml(inv.magasin)}</span>
        <span class="badge ${estCloture ? "cloture" : "en-cours"}">${estCloture ? "Clôturé" : "En cours"}</span>
      </div>
      <p class="card-sub">${escapeHtml(inv.site)} — ${escapeHtml(inv.zone)}</p>
      <p class="card-sub">${toUiDate(inv.dateInventaire)} · ${escapeHtml(inv.operateur)}</p>
    </div>
    <div id="recap-container"></div>
    <div class="search-sort-row">
      <input type="text" id="f-search" placeholder="Rechercher (référence, désignation, emplacement)" value="${escapeHtml(detailState.search)}" />
      <select id="f-sort">
        <option value="date">Date de saisie</option>
        <option value="alpha">Désignation (A-Z)</option>
        <option value="quantite">Quantité</option>
      </select>
    </div>
    <div id="lines-container"></div>
    <div class="btn-row">
      <button class="big-btn secondary" id="btn-export">📤 Exporter</button>
      ${estCloture ? "" : `<button class="big-btn secondary" id="btn-close-inv">🔒 Clôturer</button>`}
    </div>
    ${estCloture ? "" : `
      <div class="fab-row">
        <button class="big-btn outline" id="btn-scan" style="max-width:180px;">📷 Scanner</button>
        <button class="big-btn" id="btn-add-line" style="max-width:220px;">+ Ajouter une ligne</button>
      </div>`}
  `;

  document.getElementById("f-sort").value = detailState.sortMode;

  await updateDetailLists(inv);
  if (isStale()) return;

  document.getElementById("f-search").addEventListener("input", debounce((e) => {
    detailState.search = e.target.value;
    updateDetailLists(inv);
  }, 250));

  document.getElementById("f-sort").addEventListener("change", (e) => {
    detailState.sortMode = e.target.value;
    updateDetailLists(inv);
  });

  document.getElementById("btn-export").addEventListener("click", () => openExportModal(inv));

  if (!estCloture) {
    document.getElementById("btn-add-line").addEventListener("click", () => {
      navigate("articleForm", { inventoryId: inv.id });
    });
    document.getElementById("btn-scan").addEventListener("click", () => startScan(inv.id));
    document.getElementById("btn-close-inv").addEventListener("click", () => navigate("closure", { id: inv.id }));
  }
}

async function updateDetailLists(inv) {
  const allLines = await listLines(inv.id);
  const recapEl = document.getElementById("recap-container");
  const linesEl = document.getElementById("lines-container");
  if (!recapEl || !linesEl) return;

  const nbReferences = new Set(allLines.map((l) => l.reference)).size;
  const quantiteTotale = allLines.reduce((sum, l) => sum + (Number(l.quantite) || 0), 0);
  recapEl.innerHTML = `
    <div class="recap-bar">
      <div class="recap-item"><span class="recap-value">${nbReferences}</span><span class="recap-label">Références</span></div>
      <div class="recap-item"><span class="recap-value">${quantiteTotale}</span><span class="recap-label">Quantité totale</span></div>
      <div class="recap-item"><span class="recap-value">${allLines.length}</span><span class="recap-label">Lignes</span></div>
    </div>
  `;

  const query = detailState.search.trim().toLowerCase();
  let visible = allLines.filter((l) => {
    if (!query) return true;
    return (
      l.reference.toLowerCase().includes(query) ||
      l.designation.toLowerCase().includes(query) ||
      (l.emplacement || "").toLowerCase().includes(query)
    );
  });
  visible = visible.slice();
  if (detailState.sortMode === "alpha") {
    visible.sort((a, b) => a.designation.localeCompare(b.designation));
  } else if (detailState.sortMode === "quantite") {
    visible.sort((a, b) => b.quantite - a.quantite);
  } else {
    visible.sort((a, b) => a.ordre - b.ordre);
  }

  const estCloture = inv.statut === "CLOTURE";

  if (visible.length === 0) {
    linesEl.innerHTML = `<div class="empty-state"><span class="emoji">🔍</span><p>${allLines.length === 0 ? "Aucune ligne pour le moment." : "Aucun résultat pour cette recherche."}</p></div>`;
    return;
  }

  linesEl.innerHTML = visible.map((l) => lineItemHtml(l, estCloture)).join("");

  linesEl.querySelectorAll("[data-view-line]").forEach((el) => {
    el.addEventListener("click", () => navigate("articleForm", { inventoryId: inv.id, lineId: Number(el.dataset.viewLine), readOnly: estCloture }));
  });
  if (!estCloture) {
    linesEl.querySelectorAll("[data-dup-line]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const line = allLines.find((l) => l.id === Number(el.dataset.dupLine));
        await duplicateLine(line);
        showToast("Ligne dupliquée.");
        updateDetailLists(inv);
      });
    });
    linesEl.querySelectorAll("[data-del-line]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await showConfirm("Supprimer cette ligne ?", { confirmLabel: "Supprimer", danger: true });
        if (ok) {
          await deleteLine(Number(el.dataset.delLine));
          showToast("Ligne supprimée.");
          updateDetailLists(inv);
        }
      });
    });
  }
}

function lineItemHtml(l, estCloture) {
  const subParts = [];
  if (l.emplacement) subParts.push(`Emplacement : ${escapeHtml(l.emplacement)}`);
  if (l.numeroEtagere) subParts.push(`Étagère : ${escapeHtml(l.numeroEtagere)}`);
  if (l.etatMateriel) subParts.push(`État : ${ETAT_LABELS[l.etatMateriel] ?? l.etatMateriel}`);
  if (l.observation) subParts.push(escapeHtml(l.observation));
  return `
    <div class="line-item" data-view-line="${l.id}" style="cursor:pointer;">
      <div class="line-main">
        <div class="line-title">${escapeHtml(l.reference)} — ${escapeHtml(l.designation)}</div>
        ${subParts.length ? `<div class="line-sub">${subParts.join(" · ")}</div>` : ""}
      </div>
      <div class="line-qty">×${l.quantite}</div>
      ${estCloture ? "" : `
        <div class="line-actions">
          <button class="icon-btn" data-dup-line="${l.id}" title="Dupliquer">⧉</button>
          <button class="icon-btn" data-del-line="${l.id}" title="Supprimer">🗑️</button>
        </div>`}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Écran : Formulaire article (ajout / modification / consultation)
// ---------------------------------------------------------------------------

async function renderArticleForm({ inventoryId, lineId, readOnly, prefillReference }, isStale = () => false) {
  const existing = lineId ? await DB.get("lignes", lineId) : null;
  if (isStale()) return;
  const isReadOnly = !!readOnly;
  setHeader(isReadOnly ? "Consulter la ligne" : existing ? "Modifier la ligne" : "Ajouter une ligne", true);
  backBtn().onclick = goBack;

  let selectedEtat = existing?.etatMateriel ?? null;

  root().innerHTML = `
    <form id="line-form">
      <label for="f-reference">Référence *</label>
      <input type="text" id="f-reference" required value="${escapeHtml(existing?.reference ?? prefillReference ?? "")}" ${isReadOnly ? "disabled" : ""} />

      <label for="f-designation">Désignation *</label>
      <input type="text" id="f-designation" required value="${escapeHtml(existing?.designation ?? "")}" ${isReadOnly ? "disabled" : ""} />

      <label for="f-quantite">Quantité comptée *</label>
      <div class="stepper">
        ${isReadOnly ? "" : `<button type="button" id="btn-qty-minus">−</button>`}
        <input type="number" id="f-quantite" min="0" required value="${existing?.quantite ?? 1}" ${isReadOnly ? "disabled" : ""} />
        ${isReadOnly ? "" : `<button type="button" id="btn-qty-plus">+</button>`}
      </div>

      <label for="f-emplacement">Emplacement</label>
      <input type="text" id="f-emplacement" value="${escapeHtml(existing?.emplacement ?? "")}" ${isReadOnly ? "disabled" : ""} />

      <label for="f-etagere">Numéro d'étagère</label>
      <input type="text" id="f-etagere" value="${escapeHtml(existing?.numeroEtagere ?? "")}" ${isReadOnly ? "disabled" : ""} />

      <label>État du matériel</label>
      <div class="segmented" id="etat-segmented">
        ${["BON", "ENDOMMAGE", "A_VERIFIER"].map((k) => `<button type="button" data-etat="${k}" class="${selectedEtat === k ? "selected" : ""}" ${isReadOnly ? "disabled" : ""}>${ETAT_LABELS[k]}</button>`).join("")}
      </div>

      <label for="f-observation">Observation</label>
      <textarea id="f-observation" ${isReadOnly ? "disabled" : ""}>${escapeHtml(existing?.observation ?? "")}</textarea>

      ${isReadOnly ? "" : `<div class="btn-row"><button type="submit" class="big-btn">💾 Enregistrer</button></div>`}
    </form>
  `;

  if (isReadOnly) return;

  document.getElementById("btn-qty-minus").addEventListener("click", () => {
    const input = document.getElementById("f-quantite");
    input.value = Math.max(0, (parseInt(input.value, 10) || 0) - 1);
  });
  document.getElementById("btn-qty-plus").addEventListener("click", () => {
    const input = document.getElementById("f-quantite");
    input.value = (parseInt(input.value, 10) || 0) + 1;
  });

  document.getElementById("etat-segmented").querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (selectedEtat === btn.dataset.etat) {
        selectedEtat = null;
      } else {
        selectedEtat = btn.dataset.etat;
      }
      document.getElementById("etat-segmented").querySelectorAll("button").forEach((b) =>
        b.classList.toggle("selected", b.dataset.etat === selectedEtat)
      );
    });
  });

  document.getElementById("line-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const reference = document.getElementById("f-reference").value.trim();
    const designation = document.getElementById("f-designation").value.trim();
    const quantite = parseInt(document.getElementById("f-quantite").value, 10);
    if (!reference || !designation || isNaN(quantite) || quantite < 0) {
      showToast("Merci de vérifier les champs obligatoires.");
      return;
    }
    const data = {
      inventaireId: inventoryId,
      reference, designation, quantite,
      emplacement: document.getElementById("f-emplacement").value.trim() || null,
      numeroEtagere: document.getElementById("f-etagere").value.trim() || null,
      observation: document.getElementById("f-observation").value.trim() || null,
      etatMateriel: selectedEtat,
    };
    try {
      if (existing) {
        await updateLine({ ...existing, ...data });
        showToast("Ligne mise à jour.");
      } else {
        await addLine(data);
        showToast("Ligne ajoutée.");
      }
      goBack();
    } catch (err) {
      showToast("Erreur : " + err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Écran : Clôture
// ---------------------------------------------------------------------------

async function renderClosure({ id }, isStale = () => false) {
  const inv = await DB.get("inventaires", id);
  if (isStale()) return;
  if (!inv) { goHome(); return; }
  const lines = await listLines(id);
  if (isStale()) return;
  const nbReferences = new Set(lines.map((l) => l.reference)).size;
  const quantiteTotale = lines.reduce((sum, l) => sum + (Number(l.quantite) || 0), 0);

  setHeader("Clôturer l'inventaire", true);
  backBtn().onclick = goBack;

  root().innerHTML = `
    <p>Vérifiez le récapitulatif avant de clôturer définitivement cet inventaire.</p>
    <div class="card">
      <div class="card-row"><span>Numéro</span><strong>${escapeHtml(inv.numero)}</strong></div>
      <div class="card-row"><span>Date</span><strong>${toUiDate(inv.dateInventaire)}</strong></div>
      <div class="card-row"><span>Magasin</span><strong>${escapeHtml(inv.magasin)}</strong></div>
      <div class="card-row"><span>Zone</span><strong>${escapeHtml(inv.zone)}</strong></div>
      <div class="card-row"><span>Opérateur</span><strong>${escapeHtml(inv.operateur)}</strong></div>
      <hr style="border-color:var(--border)">
      <div class="card-row"><span>Nombre de lignes</span><strong>${lines.length}</strong></div>
      <div class="card-row"><span>Références distinctes</span><strong>${nbReferences}</strong></div>
      <div class="card-row"><span>Quantité totale</span><strong>${quantiteTotale}</strong></div>
    </div>
    <p style="color:var(--danger)">Une fois clôturé, cet inventaire passera en lecture seule et ne pourra plus être modifié.</p>
    <div class="btn-row"><button class="big-btn danger" id="btn-confirm-close">🔒 Clôturer l'inventaire</button></div>
  `;

  document.getElementById("btn-confirm-close").addEventListener("click", async () => {
    const ok = await showConfirm(`Confirmer la clôture définitive de ${inv.numero} ?`, {
      confirmLabel: "Clôturer", danger: true,
    });
    if (!ok) return;
    await closeInventory(id);
    showToast("Inventaire clôturé.");
    goHome();
  });
}

// ---------------------------------------------------------------------------
// Export (.xlsx / .csv) + partage
// ---------------------------------------------------------------------------

const EXPORT_HEADERS = [
  "Numéro inventaire", "Date", "Magasin", "Zone", "Opérateur",
  "Référence", "Désignation", "Quantité", "Emplacement", "Observation",
];

function buildExportRows(inv, lines) {
  const header = EXPORT_HEADERS;
  const dataRows = lines.map((l) => [
    inv.numero, toUiDate(inv.dateInventaire), inv.magasin, inv.zone, inv.operateur,
    l.reference, l.designation, l.quantite, l.emplacement || "", l.observation || "",
  ]);
  return [header, ...dataRows];
}

function exportFileName(inv, extension) {
  return `Inventaire_${slugify(inv.magasin)}_${toFileDate(inv.dateInventaire)}.${extension}`;
}

async function openExportModal(inv) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal-sheet">
      <p class="card-title">Exporter ${escapeHtml(inv.numero)}</p>
      <p id="export-status" class="card-sub"></p>
      <div class="btn-row">
        <button class="big-btn" id="btn-export-xlsx">📊 Excel (.xlsx)</button>
        <button class="big-btn outline" id="btn-export-csv">📄 CSV</button>
      </div>
      <div class="btn-row"><button class="big-btn secondary" id="btn-export-close">Fermer</button></div>
    </div>
  `;
  document.body.appendChild(backdrop);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.getElementById("btn-export-close").addEventListener("click", () => backdrop.remove());

  document.getElementById("btn-export-xlsx").addEventListener("click", () => doExport(inv, "xlsx"));
  document.getElementById("btn-export-csv").addEventListener("click", () => doExport(inv, "csv"));

  async function doExport(inv, format) {
    const status = document.getElementById("export-status");
    status.textContent = "Génération en cours…";
    try {
      const lines = await listLines(inv.id);
      const rows = buildExportRows(inv, lines);
      const filename = exportFileName(inv, format);
      let bytes, mime;
      if (format === "xlsx") {
        const typedRows = rows.map((row, i) =>
          row.map((cell) => (i > 0 && typeof cell === "number" ? { type: "n", value: cell } : { type: "s", value: cell }))
        );
        // La colonne Quantité (index 7) est numérique sur les lignes de données.
        typedRows.slice(1).forEach((row) => { row[7] = { type: "n", value: Number(row[7].value) || 0 }; });
        bytes = buildXlsx(typedRows);
        mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      } else {
        bytes = buildCsv(rows);
        mime = "text/csv";
      }
      const blob = new Blob([bytes], { type: mime });
      status.textContent = `Fichier généré : ${filename}`;
      await shareOrDownload(blob, filename, mime);
    } catch (err) {
      status.textContent = "Erreur lors de l'export : " + err.message;
    }
  }
}

async function shareOrDownload(blob, filename, mime) {
  if (navigator.canShare && navigator.share) {
    try {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (err) {
      // L'utilisateur a annulé le partage, ou l'API a échoué : on retombe sur le téléchargement.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// Scan code-barres / QR (BarcodeDetector natif — fallback saisie manuelle)
// ---------------------------------------------------------------------------

let scanStream = null;
let scanLoopHandle = null;
let scanLocked = false;

async function startScan(inventoryId) {
  const overlay = document.getElementById("scan-overlay");
  const video = document.getElementById("scan-video");
  const statusEl = document.getElementById("scan-status");
  overlay.hidden = false;
  scanLocked = false;

  document.getElementById("btn-scan-close").onclick = () => stopScan();
  document.getElementById("btn-scan-manual").onclick = () => {
    stopScan();
    navigate("articleForm", { inventoryId });
  };

  if (!("BarcodeDetector" in window)) {
    statusEl.textContent = "Scan non pris en charge par ce navigateur — utilisez la saisie manuelle.";
    return;
  }

  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = scanStream;
    statusEl.textContent = "Visez un code-barres (EAN) ou un QR code…";

    const detector = new BarcodeDetector({
      formats: ["ean_13", "ean_8", "qr_code", "upc_a", "upc_e", "code_128"],
    });

    const loop = async () => {
      if (scanStream === null) return; // scan arrêté
      try {
        const barcodes = await detector.detect(video);
        if (barcodes.length > 0 && !scanLocked) {
          scanLocked = true;
          await onBarcodeDetected(inventoryId, barcodes[0].rawValue);
        }
      } catch (err) {
        // frame non exploitable, on continue
      }
      scanLoopHandle = requestAnimationFrame(loop);
    };
    scanLoopHandle = requestAnimationFrame(loop);
  } catch (err) {
    statusEl.textContent = "Caméra indisponible (" + err.message + ") — utilisez la saisie manuelle.";
  }
}

async function onBarcodeDetected(inventoryId, code) {
  const lines = await listLines(inventoryId);
  const existing = lines.find((l) => l.reference === code);
  if (existing) {
    await updateLine({ ...existing, quantite: existing.quantite + 1, dateSaisie: nowIso() });
    showToast(`Article existant (${code}), quantité +1`);
    setTimeout(() => { scanLocked = false; }, 1200);
  } else {
    stopScan();
    navigate("articleForm", { inventoryId, prefillReference: code });
  }
}

function stopScan() {
  document.getElementById("scan-overlay").hidden = true;
  if (scanLoopHandle) cancelAnimationFrame(scanLoopHandle);
  scanLoopHandle = null;
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  document.getElementById("btn-theme").addEventListener("click", toggleTheme);
  // Le bouton "Retour" n'est PAS câblé ici : chaque écran définit
  // `backBtn().onclick` avec la bonne cible (goBack ou goHome selon le cas).
  // Ajouter aussi un addEventListener ici doublerait le déclenchement à
  // chaque clic (deux mécanismes actifs en même temps sur le même bouton).
  await render();
});
