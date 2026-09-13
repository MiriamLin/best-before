import dotenv from "dotenv";

import { buildStandardLeaderboard } from "../src/standard-leaderboard.js";

dotenv.config({ quiet: true });

function renderTable(columns, rows) {
  const widths = columns.map((column, index) => Math.max(
    column.length,
    ...rows.map((row) => String(row[index]).length),
  ));
  const separator = `+-${widths.map((width) => "-".repeat(width)).join("-+-")}-+`;
  const renderRow = (row) => `| ${row.map(
    (value, index) => String(value).padEnd(widths[index]),
  ).join(" | ")} |`;

  console.log(separator);
  console.log(renderRow(columns));
  console.log(separator);
  for (const row of rows) {
    console.log(renderRow(row));
  }
  console.log(separator);
}

const leaderboard = await buildStandardLeaderboard({
  graphApiKey: process.env.GRAPH_API_KEY,
});

console.log("\nMESSARI STANDARDIZED LENDING FRESHNESS LEADERBOARD\n");
renderTable(
  ["Protocol", "Chain", "Schema", "TVL", "Freshness"],
  leaderboard.rows.map((row) => [
    row.protocol,
    row.chain,
    row.schema,
    row.tvl,
    row.reason == null ? row.freshness : `${row.freshness} / ${row.reason}`,
  ]),
);

console.log("\nBASE DEPLOYMENT DIAGNOSTICS\n");
renderTable(
  ["Protocol", "Status", "Reason"],
  leaderboard.diagnostics.map((row) => [row.protocol, row.status, row.reason]),
);

console.log(`
Conclusion
- Standardization lets one Protocol query retrieve comparable TVL from five protocols without five adapters.
- Freshness, schema version, and deployment correctness remain independent checks.
- Standardization solves how to ask, not whether the answer can be trusted.
`);
