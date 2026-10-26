/**
 * The first version of a self-made connector, written the moment it is created so it works before
 * the Claude turn that tailors it has finished: one generic `request` tool against the API base URL
 * (or, for a connector described in words, a `describe` tool that says it is still being built).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Connector } from "./store.ts";

export const RUNTIME_SOURCE = readFileSync(join(dirname(Bun.fileURLToPath(import.meta.url)), "runtime.ts"), "utf8");

export function scaffoldServer(c: Connector): string {
  const l = c.local!;
  const name = JSON.stringify(c.id);
  if (!l.baseUrl) {
    return `// ${c.name}: a Bridge connector. Bridge is writing its tools; until then it only explains itself.
import { serve } from "../_runtime/mcp.ts";

serve({
  name: ${name},
  tools: [
    {
      name: "about",
      description: ${JSON.stringify("What this connector is for: " + (l.description || c.name).slice(0, 300))},
      run: () => ${JSON.stringify("This connector is still being built from the description: " + (l.description || "").slice(0, 600))},
    },
  ],
});
`;
  }
  return `// ${c.name}: a Bridge connector for ${l.baseUrl}
// The API base URL and the token arrive as API_BASE_URL / API_TOKEN; see ../_runtime/mcp.ts.
import { serve, api } from "../_runtime/mcp.ts";

serve({
  name: ${name},
  tools: [
    {
      name: "request",
      description: ${JSON.stringify("Call the " + c.name + " API at " + l.baseUrl + ". `path` is relative to that base, e.g. /users/1.")},
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method, GET by default" },
          path: { type: "string", description: "Path under the base URL" },
          query: { type: "object", description: "Query string parameters" },
          body: { type: "object", description: "JSON body for POST/PUT/PATCH" },
        },
        required: ["path"],
      },
      run: (a) => api(a.path, { method: a.method || "GET", query: a.query, body: a.body }),
    },
  ],
});
`;
}
