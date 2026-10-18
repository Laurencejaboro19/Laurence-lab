// Vercel function entry. All routes are rewritten here (see vercel.json); the
// compiled Fastify app in dist/ handles them.
//
// The app is imported lazily and every failure — a module that will not load,
// an environment variable that fails validation, a crash while building the
// server — is reported in the HTTP response instead of Vercel's opaque
// "FUNCTION_INVOCATION_FAILED" page, so the owner can read the cause in the
// browser. Secrets never appear in these messages: the env loader only names
// the variable that is wrong, and stack traces contain file paths, not values.

let modulePromise = null;

function loadModule() {
  modulePromise ??= import('../dist/http/serverless.js').catch((err) => {
    modulePromise = null;
    throw err;
  });
  return modulePromise;
}

export default async function handler(req, res) {
  try {
    const mod = await loadModule();
    await mod.default(req, res);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error('laurence-lab-bot: request failed', message);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify(
          {
            error: 'function failed',
            message: err instanceof Error ? err.message : String(err),
            node: process.version,
            hint: 'docs/DEPLOY_VERCEL.md § Troubleshooting',
          },
          null,
          2,
        ),
      );
    } else {
      res.end();
    }
  }
}
