import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';

test('Vitestから node:sqlite をimportできる', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(a)');
  db.prepare('INSERT INTO t VALUES (?)').run(1);
  expect(db.prepare('SELECT a FROM t').get()).toEqual({ a: 1 });
  db.close();
});
