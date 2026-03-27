import * as fs from "fs/promises";
import * as path from "path";

interface ServiceOffering {
  serviceId: number;
  name: string;
  description: string;
  sla?: number;
  requirements?: Record<string, unknown>;
  deliverables?: Record<string, unknown>;
}

interface ManifestService {
  name: string;
  endpoint: string;
  version?: string;
  offerings?: ServiceOffering[];
}

interface ManifestConfig {
  agentName: string;
  description?: string;
  image?: string;
  version?: string;
  services?: ManifestService[];
  oasf?: {
    skills?: Array<{ category: string; items: string[] }>;
    domains?: Array<{ category: string; items: string[] }>;
  };
  contact?: {
    email?: string;
    website?: string;
  };
  x402Support?: boolean;
}

async function main() {
  const configPath = path.resolve("manifest.config.json");
  const outputPath = path.resolve("manifest.json");

  let config: ManifestConfig;
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    console.error("manifest.config.json not found. Copy manifest.config.example.json first.");
    process.exit(1);
    return;
  }

  if (!config.agentName) {
    console.error("manifest.config.json must include agentName.");
    process.exit(1);
  }

  const manifest = {
    type: "https://multiversx.com/standards/mx-8004#registration-v1",
    name: config.agentName,
    description: config.description || `${config.agentName} — Battle of Nodes agent`,
    image: config.image,
    version: config.version || "1.0.0",
    active: true,
    services: config.services || [],
    oasf: {
      schemaVersion: "0.8.0",
      skills: config.oasf?.skills || [],
      domains: config.oasf?.domains || [],
    },
    contact: config.contact,
    x402Support: config.x402Support ?? false,
  };

  await fs.writeFile(outputPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`Manifest written to ${outputPath}`);
}

main().catch(error => {
  console.error("Failed to build manifest:", error);
  process.exit(1);
});
