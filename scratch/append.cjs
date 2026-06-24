const fs = require("fs");
let content = fs.readFileSync("src/server/domains.ts", "utf-8");
if (!content.includes("batchPushDnsToCloudflare")) {
  content = content.replace(
    'import { planDomain } from "@/lib/planning";',
    'import { planDomain } from "@/lib/planning";\nimport dns from "dns/promises";',
  );
  const append = fs.readFileSync("scratch/append_domains.ts", "utf-8");
  fs.writeFileSync("src/server/domains.ts", content + "\n" + append);
  console.log("Successfully appended domains.ts");
} else {
  console.log("Already appended domains.ts");
}
