import { migrate, dbFilePath } from './index';

migrate();
console.log(`[db:migrate] schema applied at ${dbFilePath}`);
