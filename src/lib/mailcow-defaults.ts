/**
 * Standard Mailcow DNS records for a domain.
 * DKIM is a placeholder until Mailcow generates the real key.
 * `name` uses "@" for apex; serializeName turns it into the FQDN for Cloudflare.
 */
export interface SeedRecord {
  type: "A" | "MX" | "TXT" | "CNAME" | "SRV";
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
}

export function seedMailcowRecords(domain: string, mailHostIp: string): SeedRecord[] {
  return [
    { type: "A", name: "mail", content: mailHostIp, ttl: 1 },
    { type: "MX", name: "@", content: `mail.${domain}.`, priority: 10, ttl: 1 },
    { type: "CNAME", name: "autodiscover", content: `mail.${domain}.`, ttl: 1 },
    { type: "CNAME", name: "autoconfig", content: `mail.${domain}.`, ttl: 1 },
    { type: "TXT", name: "@", content: `v=spf1 mx ~all`, ttl: 1 },
    {
      type: "TXT",
      name: "_dmarc",
      content: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`,
      ttl: 1,
    },
    // Placeholder DKIM — real key pushed back after Mailcow domain creation
    {
      type: "TXT",
      name: "dkim._domainkey",
      content: `v=DKIM1; k=rsa; p=PLACEHOLDER_REPLACE_AFTER_MAILCOW_SETUP`,
      ttl: 1,
    },
    { type: "SRV", name: "_imaps._tcp", content: `0 1 993 mail.${domain}.`, priority: 0, ttl: 1 },
    {
      type: "SRV",
      name: "_submission._tcp",
      content: `0 1 587 mail.${domain}.`,
      priority: 0,
      ttl: 1,
    },
  ];
}

export function fqdn(domain: string, name: string): string {
  if (name === "@" || name === "" || name === domain) return domain;
  if (name.endsWith(`.${domain}`)) return name;
  return `${name}.${domain}`;
}

export const VPS_SETUP_STEPS = [
  {
    id: "update_docker",
    title: "Update system & install Docker",
    command:
      "sudo apt update && sudo apt upgrade -y && curl -sSL https://get.docker.com/ | CHANNEL=stable sh && systemctl enable --now docker",
  },
  {
    id: "clone_mailcow",
    title: "Clone Mailcow",
    command:
      "cd /opt && git clone https://github.com/mailcow/mailcow-dockerized && cd mailcow-dockerized",
  },
  {
    id: "configure",
    title: "Configure Mailcow",
    command:
      "cd /opt/mailcow-dockerized && ./generate_config.sh\n# When prompted for hostname, enter:  mail.<your-domain>",
  },
  {
    id: "start",
    title: "Start Mailcow",
    command: "cd /opt/mailcow-dockerized && docker compose pull && docker compose up -d",
  },
  {
    id: "api_key",
    title: "Create a read/write API key",
    command:
      "# Open https://mail.<your-domain>/admin in your browser\n# Go to: System → Configuration → Access → API\n# Enable API + Read/Write, allow your IP, then copy the key into the domain settings here.",
  },
] as const;

export type VpsStepId = (typeof VPS_SETUP_STEPS)[number]["id"];
