// Vercel function entry. All routes are rewritten here (see vercel.json); the
// compiled Fastify app in dist/ handles them. Keep this file free of logic.
export { default } from '../dist/http/serverless.js';
