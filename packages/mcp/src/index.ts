import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { serverVersion } from "./project";
import { createServer } from "./server";

await createServer(await serverVersion()).connect(new StdioServerTransport());
