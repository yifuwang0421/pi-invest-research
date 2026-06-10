import { IFindMcpAdapter } from "../src/ifind-adapter.js";

const target = process.argv[2] ?? "贵州茅台";
const adapter = new IFindMcpAdapter();

const result = await adapter.queryIFind({
  server: "stock",
  intent: "quote",
  target,
  query: `${target} 行情`,
});

console.log(JSON.stringify(result, null, 2));

if (result.evidence.length === 0) {
  process.exitCode = 1;
}
