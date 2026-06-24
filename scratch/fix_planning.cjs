const fs = require("fs");
let content = fs.readFileSync("src/lib/planning.ts", "utf-8");
content = content.replace(
  "return { domain, totalInboxes: 0, subdomainCount: 0, inboxes: [] };",
  "return { domain, totalInboxes: 0, subdomainCount: 0, subdomainDistribution: {}, inboxes: [] };",
);
fs.writeFileSync("src/lib/planning.ts", content);
