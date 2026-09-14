// Loads packages/db/.env (DATABASE_URL, etc.) as a side effect of importing this file.
//
// Why this is its own file: this script is run with `tsx`, which executes .ts files as native ES
// modules. Under ES modules, every `import` at the top of a file is resolved and run *before* any of
// that file's own code runs -- so calling dotenv's `config()` in the middle of seed.ts's import list
// would not actually run in time to affect the next import. Putting the `config()` call inside its
// own module and importing *that* module first works because Node fully executes each imported
// module (in the order it's imported) before moving on to the next one -- so this file's `config()`
// call is guaranteed to run before seed.ts's later import of "../src/index" (which reads
// `process.env.DATABASE_URL` as soon as it's loaded).
//
// This matters because `npx prisma migrate reset` / `npx prisma migrate dev` load this .env file
// automatically (that's built into the Prisma CLI), and so does `next dev` (built into Next.js) --
// but nothing loads it automatically when this script is run directly via `tsx prisma/seed.ts`
// (i.e. plain `pnpm db:seed`).
import path from "node:path";
import { config } from "dotenv";

config({ path: path.join(__dirname, "..", ".env") });
