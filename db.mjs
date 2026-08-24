// ============================================================================
// SQLite Database Layer for Qoder API Gateway
// Uses Node.js native DatabaseSync (node:sqlite) for high-performance zero-dependency storage
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'qoder.db');

function md5(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}

function generateApiKey() {
  return 'sk-qoder-' + crypto.randomBytes(24).toString('hex');
}

// Initialize SQLite database instance
const db = new DatabaseSync(DB_PATH);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_md5 TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    model TEXT NOT NULL,
    protocol TEXT NOT NULL,
    is_warm INTEGER NOT NULL,
    ttfb_ms INTEGER,
    duration_ms INTEGER NOT NULL,
    status INTEGER NOT NULL
  );
`);

// Initialize default admin user (admin / admin)
const userStmt = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?');
const defaultUser = userStmt.get('admin');
if (!defaultUser) {
  const insertUser = db.prepare('INSERT INTO users (username, password_md5, updated_at) VALUES (?, ?, ?)');
  insertUser.run('admin', md5('admin'), Date.now());
  console.log('[db] SQLite: Created default admin user (admin / admin)');
}

// Initialize default settings
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
if (!getSettingStmt.get('api_auth_enabled')) {
  const setSetting = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  setSetting.run('api_auth_enabled', 'false', Date.now());
}
if (!getSettingStmt.get('api_auth_key')) {
  const setSetting = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
  setSetting.run('api_auth_key', generateApiKey(), Date.now());
}

export const Database = {
  // User Authentication
  getUser(username) {
    const stmt = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)');
    const row = stmt.get(username);
    if (!row) return null;
    return { username: row.username, passwordMd5: row.password_md5 };
  },

  isDefaultPassword() {
    const adminUser = this.getUser('admin') || this.getUser('Admin');
    if (!adminUser) return false;
    return adminUser.passwordMd5 === md5('admin') || adminUser.passwordMd5 === md5('Admin');
  },

  updatePassword(username, newPasswordMd5) {
    const stmt = db.prepare('UPDATE users SET password_md5 = ?, updated_at = ? WHERE LOWER(username) = LOWER(?)');
    stmt.run(newPasswordMd5, Date.now(), username);
  },

  // Key-Value Settings
  getSetting(key, defaultValue = '') {
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key);
    return row ? row.value : defaultValue;
  },

  setSetting(key, value) {
    const stmt = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    stmt.run(key, String(value), Date.now());
  },

  // API Token Auth Config
  getApiAuthConfig() {
    const enabledStr = this.getSetting('api_auth_enabled', 'false');
    let apiKey = this.getSetting('api_auth_key', '');
    if (!apiKey) {
      apiKey = generateApiKey();
      this.setSetting('api_auth_key', apiKey);
    }
    return {
      enabled: enabledStr === 'true',
      apiKey,
    };
  },

  setApiAuthConfig(enabled, apiKey) {
    if (typeof enabled === 'boolean') {
      this.setSetting('api_auth_enabled', enabled ? 'true' : 'false');
    }
    if (typeof apiKey === 'string' && apiKey.trim()) {
      this.setSetting('api_auth_key', apiKey.trim());
    }
  },

  regenerateApiKey() {
    const newKey = generateApiKey();
    this.setSetting('api_auth_key', newKey);
    return newKey;
  },

  // Session Management
  createSession(username, ttlMs = 7 * 24 * 60 * 60 * 1000) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const stmt = db.prepare('INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)');
    stmt.run(token, username, now, expiresAt);
    return token;
  },

  getSession(token) {
    if (!token) return null;
    const stmt = db.prepare('SELECT * FROM sessions WHERE token = ?');
    const row = stmt.get(token);
    if (!row) return null;
    if (Date.now() > row.expires_at) {
      this.deleteSession(token);
      return null;
    }
    return { token: row.token, username: row.username, expiresAt: row.expires_at };
  },

  deleteSession(token) {
    if (!token) return;
    const stmt = db.prepare('DELETE FROM sessions WHERE token = ?');
    stmt.run(token);
  },

  cleanExpiredSessions() {
    const stmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
    stmt.run(Date.now());
  },

  // Audit Logs
  logRequest({ model, protocol, isWarm, ttfbMs, durationMs, status }) {
    try {
      const stmt = db.prepare('INSERT INTO request_logs (timestamp, model, protocol, is_warm, ttfb_ms, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
      stmt.run(Date.now(), model, protocol, isWarm ? 1 : 0, ttfbMs || null, durationMs, status);
    } catch (e) {
      console.warn('[db] Failed to log request:', e.message);
    }
  },
};

// Periodic session cleanup
setInterval(() => {
  try { Database.cleanExpiredSessions(); } catch (e) {}
}, 60 * 60 * 1000);
