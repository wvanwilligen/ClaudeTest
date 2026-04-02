const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'strava.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS activities (
    id                   INTEGER PRIMARY KEY,
    name                 TEXT    NOT NULL,
    type                 TEXT    NOT NULL,
    distance             REAL    DEFAULT 0,
    moving_time          INTEGER DEFAULT 0,
    elapsed_time         INTEGER DEFAULT 0,
    start_date           TEXT    NOT NULL,
    start_date_local     TEXT    NOT NULL,
    average_heartrate    REAL,
    max_heartrate        REAL,
    average_speed        REAL,
    total_elevation_gain REAL,
    map_polyline         TEXT
  );
  CREATE TABLE IF NOT EXISTS band_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL,
    note       TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrate existing databases that may be missing newer columns
const migrateColumns = [
  'ALTER TABLE activities ADD COLUMN elapsed_time INTEGER DEFAULT 0',
  'ALTER TABLE activities ADD COLUMN max_heartrate REAL',
  'ALTER TABLE activities ADD COLUMN average_speed REAL',
];
for (const sql of migrateColumns) {
  try { db.exec(sql); } catch (_) { /* column already exists — safe to ignore */ }
}

const _upsert = db.prepare(`
  INSERT OR REPLACE INTO activities
    (id, name, type, distance, moving_time, elapsed_time, start_date, start_date_local,
     average_heartrate, max_heartrate, average_speed, total_elevation_gain, map_polyline)
  VALUES
    (@id, @name, @type, @distance, @moving_time, @elapsed_time, @start_date, @start_date_local,
     @average_heartrate, @max_heartrate, @average_speed, @total_elevation_gain, @map_polyline)
`);
const _upsertMany = db.transaction(rows => { for (const r of rows) _upsert.run(r); });

function saveActivities(raw) {
  if (!raw.length) return;
  _upsertMany(raw.map(a => ({
    id:                   a.id,
    name:                 a.name,
    type:                 a.type,
    distance:             a.distance             ?? 0,
    moving_time:          a.moving_time          ?? 0,
    elapsed_time:         a.elapsed_time         ?? 0,
    start_date:           a.start_date,
    start_date_local:     a.start_date_local,
    average_heartrate:    a.average_heartrate    ?? null,
    max_heartrate:        a.max_heartrate        ?? null,
    average_speed:        a.average_speed        ?? null,
    total_elevation_gain: a.total_elevation_gain ?? null,
    map_polyline:         a.map?.summary_polyline ?? null,
  })));
}

function getMostRecentActivityDate() {
  return db.prepare('SELECT MAX(start_date) as d FROM activities').get()?.d ?? null;
}

function getActivitiesInRange(fromDate, toDate) {
  return db.prepare(`
    SELECT * FROM activities
    WHERE substr(start_date_local, 1, 10) >= ?
      AND substr(start_date_local, 1, 10) <= ?
    ORDER BY start_date_local ASC
  `).all(fromDate, toDate);
}

function getActivityById(id) {
  return db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
}

function getAllActivities() {
  return db.prepare('SELECT * FROM activities ORDER BY distance DESC').all();
}

function addBandSession(date, note) {
  return db.prepare('INSERT INTO band_sessions (date, note) VALUES (?, ?)').run(date, note || null);
}

function deleteBandSession(id) {
  return db.prepare('DELETE FROM band_sessions WHERE id = ?').run(id);
}

function getBandSessionsInRange(fromDate, toDate) {
  return db.prepare(`
    SELECT * FROM band_sessions
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC, created_at ASC
  `).all(fromDate, toDate);
}

function getAllBandSessions() {
  return db.prepare('SELECT * FROM band_sessions ORDER BY date DESC, created_at DESC').all();
}

function getRunDatesAfter(fromDate) {
  return db.prepare(`
    SELECT substr(start_date_local, 1, 10) as date
    FROM activities
    WHERE type IN ('Run','VirtualRun','TrailRun')
      AND substr(start_date_local, 1, 10) >= ?
  `).all(fromDate).map(r => r.date);
}

function getBandDatesAfter(fromDate) {
  return db.prepare('SELECT date FROM band_sessions WHERE date >= ?')
    .all(fromDate).map(r => r.date);
}

module.exports = {
  saveActivities,
  getMostRecentActivityDate,
  getActivitiesInRange,
  getActivityById,
  getAllActivities,
  addBandSession,
  deleteBandSession,
  getBandSessionsInRange,
  getAllBandSessions,
  getRunDatesAfter,
  getBandDatesAfter,
};
