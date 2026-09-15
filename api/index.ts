import type { IncomingMessage, ServerResponse } from 'node:http';
import vercelHandler from '../src/app.js';

// Keep Vercel's entrypoint in its conventional api/ directory. The wrapper is
// intentionally a direct function export, which Vercel validates at build time.
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return vercelHandler(req, res);
}
