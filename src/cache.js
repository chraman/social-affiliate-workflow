const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../config/product-cache.json');
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

class ProductCache {
  constructor() {
    this.store = {};
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        this.store = JSON.parse(raw);
        console.log(`📦 Cache loaded: ${Object.keys(this.store).length} entries`);
      }
    } catch {
      this.store = {};
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(this.store, null, 2));
    } catch (err) {
      console.warn('⚠️  Cache save failed:', err.message);
    }
  }

  async get(url) {
    const entry = this.store[url];
    if (!entry) return null;
    if (Date.now() - entry.timestamp > TTL_MS) {
      delete this.store[url];
      return null;
    }
    console.log('⚡ Cache hit for:', url);
    return entry.data;
  }

  async set(url, data) {
    this.store[url] = { data, timestamp: Date.now() };
    this._save();
  }

  clear() {
    this.store = {};
    this._save();
  }
}

const cache = new ProductCache();
module.exports = { cache };
