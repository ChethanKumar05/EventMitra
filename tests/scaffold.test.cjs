const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(base, p), 'utf8');

test('server.ts uses typed HTTP server and Socket.IO', () => {
  assert.match(read('src/server.ts'), /createServer/);
  assert.match(read('src/server.ts'), /startSocket/);
});

test('the six ordered migrations exist', () => {
  for (const name of ['001_admin','002_user','003_owner','004_venue','005_booking','006_reviews']) {
    assert.ok(fs.readdirSync(path.join(base, 'src/migrations')).some(f => f.startsWith(name)));
  }
});

test('migration runner tracks migration history, serializes, and commits', () => {
  const code = read('src/migrations/runMigrations.ts');
  for (const token of ['migrations_history','pg_advisory_lock',"client.query('BEGIN')","client.query('COMMIT')","client.query('ROLLBACK')"]) {
    assert.ok(code.includes(token), token);
  }
});

test('binding parameters are used in read-only venue model', () => {
  const code = read('src/models/venueModel.ts');
  assert.match(code, /LIMIT \$1 OFFSET \$2/);
  assert.match(code, /venue_id = \$1/);
});
