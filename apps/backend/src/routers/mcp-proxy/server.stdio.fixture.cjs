/* eslint-disable turbo/no-undeclared-env-vars */
// A real, dependency-free JSON-RPC MCP child. Never return environment values.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Executed directly as a CommonJS child fixture.
const { createInterface } = require("node:readline");

let initialized = false;
const expectedArgs = ["two words", "'quoted'", "semi;colon", "$CANARY"];
const input = createInterface({ input: process.stdin });

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "notifications/initialized") {
    initialized = true;
    return;
  }
  if (message.id === undefined) return;

  let result;
  switch (message.method) {
    case "initialize":
      if (process.env.INSPECTOR_FIXTURE_MALFORMED_STDOUT) {
        const password = process.env.INSPECTOR_FIXTURE_PASSWORD;
        process.stdout.write(`${password}\n`);
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: password, method: 37 }) + "\n",
        );
      }
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "inspector-stdio-fixture", version: "1.0.0" },
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = {
        tools: [{ name: "environment_probe", inputSchema: { type: "object" } }],
      };
      break;
    case "tools/call":
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              initialized,
              savedCredentialPresent:
                process.env.INSPECTOR_FIXTURE_PASSWORD ===
                "virtual-only-route-password",
              hostCanaryAbsent: !Object.hasOwn(
                process.env,
                "INSPECTOR_ROUTE_HOST_CANARY",
              ),
              literalArgvPreserved:
                JSON.stringify(process.argv.slice(2)) ===
                JSON.stringify(expectedArgs),
              privateDirectoriesPresent:
                Boolean(process.env.HOME) &&
                Boolean(process.env.TMPDIR) &&
                process.env.HOME !== process.env.TMPDIR,
            }),
          },
        ],
      };
      break;
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        }) + "\n",
      );
      return;
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n",
  );
});
