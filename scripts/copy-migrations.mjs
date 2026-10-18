// tsc does not copy .sql files; the migration runner reads them next to dist/db/migrate.js.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/db/migrations', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('copied migrations to dist/db/migrations');
