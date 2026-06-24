// Post-build script: generates api/index.js at the project root as the Vercel serverless function entry point.
// Vercel requires serverless functions to be in the 'api' directory at the project root level.
// Also copies client assets to root for proper static file serving.
import { writeFileSync, mkdirSync, existsSync, cpSync } from "fs";

// Create the api directory at project root
const apiDir = "api";
if (!existsSync(apiDir)) {
  mkdirSync(apiDir, { recursive: true });
}

// Copy the server build to api/ (Vercel needs the handler at root level)
cpSync("dist/server", apiDir, { recursive: true });

// Create the entry point that re-exports the handler
const entryPoint = `// Vercel serverless function entry point
import handler from './server.js';
export default handler;
`;

writeFileSync("api/index.js", entryPoint);

// Add package.json to ensure ES modules work on Vercel serverless
const packageJson = `{
  "type": "module"
}
`;
writeFileSync("api/package.json", packageJson);

// Copy client assets to root level for proper static file serving by Vercel
cpSync("dist/client", ".", { recursive: true });

console.log("✓ Created Vercel serverless function entry point at api/index.js");
console.log("✓ Server assets copied to api/ for SSR deployment");
console.log("✓ Client assets copied to root for static file serving");
console.log("✓ Added api/package.json for ES modules support");
