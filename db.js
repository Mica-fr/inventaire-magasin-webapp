"use strict";
/**
 * Couche d'accès aux données — IndexedDB.
 * Aucune dépendance externe (fonctionne hors-ligne, y compris ouvert en
 * fichier local, sans serveur).
 *
 * Object stores :
 *  - inventaires   (keyPath: id, autoIncrement) — index "numero" (unique), "statut"
 *  - lignes        (keyPath: id, autoIncrement) — index "inventaireId"
 *  - sequence      (keyPath: annee)             — compteur pour la numérotation auto
 *  - preferences   (keyPath: cle)               — thème, etc.
 */
const DB_NAME = "InventaireMagasinDB";
const DB_VERSION = 1;

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("inventaires")) {
        const store = db.createObjectStore("inventaires", { keyPath: "id", autoIncrement: true });
        store.createIndex("numero", "numero", { unique: true });
        store.createIndex("statut", "statut", { unique: false });
      }
      if (!db.objectStoreNames.contains("lignes")) {
        const store = db.createObjectStore("lignes", { keyPath: "id", autoIncrement: true });
        store.createIndex("inventaireId", "inventaireId", { unique: false });
      }
      if (!db.objectStoreNames.contains("sequence")) {
        db.createObjectStore("sequence", { keyPath: "annee" });
      }
      if (!db.objectStoreNames.contains("preferences")) {
        db.createObjectStore("preferences", { keyPath: "cle" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

/** Exécute une transaction et retourne une Promise du résultat de `fn(store)`. */
function tx(storeName, mode, fn) {
  return openDb().then((db) => {
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      let result;
      Promise.resolve(fn(store))
        .then((r) => { result = r; })
        .catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  add(storeName, value) {
    return tx(storeName, "readwrite", (store) => reqToPromise(store.add(value)));
  },
  put(storeName, value) {
    return tx(storeName, "readwrite", (store) => reqToPromise(store.put(value)));
  },
  get(storeName, key) {
    return tx(storeName, "readonly", (store) => reqToPromise(store.get(key)));
  },
  getAll(storeName) {
    return tx(storeName, "readonly", (store) => reqToPromise(store.getAll()));
  },
  getAllByIndex(storeName, indexName, value) {
    return tx(storeName, "readonly", (store) =>
      reqToPromise(store.index(indexName).getAll(value))
    );
  },
  delete(storeName, key) {
    return tx(storeName, "readwrite", (store) => reqToPromise(store.delete(key)));
  },
};

/**
 * Génère le numéro d'inventaire auto : INV-<année>-<séquence sur 4 chiffres>.
 * Transaction atomique sur le store "sequence" pour éviter toute collision.
 */
async function nextNumeroInventaire(date) {
  const annee = date.getFullYear();
  return tx("sequence", "readwrite", async (store) => {
    const existing = await reqToPromise(store.get(annee));
    const dernier = existing ? existing.dernierNumero : 0;
    const suivant = dernier + 1;
    await reqToPromise(store.put({ annee, dernierNumero: suivant }));
    return `INV-${annee}-${String(suivant).padStart(4, "0")}`;
  });
}
