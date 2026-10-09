import { describe, it, expect } from "bun:test";
import {
  KNOWN_SERVICES,
  SERVICE_DEFS,
  normalizeServices,
  renderComposeYaml,
  serviceEnv,
  renderEnvFile
} from "../orchestrator/service_manager.ts";

describe("Service Manager Module", () => {
  describe("KNOWN_SERVICES", () => {
    it("should include standard services", () => {
      expect(KNOWN_SERVICES).toContain("postgres");
      expect(KNOWN_SERVICES).toContain("redis");
      expect(KNOWN_SERVICES).toContain("mongo");
      expect(KNOWN_SERVICES).toContain("minio");
      expect(KNOWN_SERVICES).toContain("s3");
    });
  });

  describe("normalizeServices", () => {
    it("should resolve preset string 'postgres'", () => {
      const normalized = normalizeServices(["postgres"]);
      expect(normalized.length).toBe(1);
      expect(normalized[0].name).toBe("postgres");
      expect(normalized[0].image).toBe(SERVICE_DEFS.postgres.image);
      expect(normalized[0].ports).toEqual(["5432:5432"]);
      expect(normalized[0].env.DATABASE_URL).toBeDefined();
    });

    it("should map 'minio' to 's3'", () => {
      const normalized = normalizeServices(["minio"]);
      expect(normalized.length).toBe(1);
      expect(normalized[0].name).toBe("s3");
    });

    it("should handle custom service objects", () => {
      const custom = {
        name: "Custom-API",
        image: "my-api:latest",
        env: { FOO: "bar" },
        ports: ["8080:80"]
      };
      const normalized = normalizeServices([custom]);
      expect(normalized.length).toBe(1);
      expect(normalized[0].name).toBe("custom-api"); // normalized lowercase
      expect(normalized[0].image).toBe("my-api:latest");
      expect(normalized[0].env).toEqual({ FOO: "bar" });
      expect(normalized[0].ports).toEqual(["8080:80"]);
    });

    it("should deduplicate by name", () => {
      const normalized = normalizeServices(["redis", "redis"]);
      expect(normalized.length).toBe(1);
      expect(normalized[0].name).toBe("redis");
    });
  });

  describe("renderComposeYaml", () => {
    it("should generate correct YAML for postgres", () => {
      const yaml = renderComposeYaml(["postgres"]);
      expect(yaml).toContain("services:");
      expect(yaml).toContain("postgres:");
      expect(yaml).toContain("image: postgres:16-alpine");
      expect(yaml).toContain("POSTGRES_USER: postgres");
      expect(yaml).toContain("test: [\"CMD-SHELL\",\"pg_isready -U postgres\"]");
    });

    it("should generate minimal valid YAML for empty specs", () => {
      const yaml = renderComposeYaml([]);
      expect(yaml).toContain("services:");
      expect(yaml.split("\n").filter(l => l.trim().length > 0).length).toBe(3); // comments + services:
    });
  });

  describe("serviceEnv", () => {
    it("should merge env from multiple services", () => {
      const env = serviceEnv(["postgres", "redis"]);
      expect(env.DATABASE_URL).toBeDefined();
      expect(env.REDIS_URL).toBeDefined();
    });
  });

  describe("renderEnvFile", () => {
    it("should produce KEY=VAL format with newline termination", () => {
      const envFile = renderEnvFile([{ name: "test", image: "test", env: { A: "1", B: "2" } }]);
      expect(envFile).toBe("A=1\nB=2\n");
    });
  });
});
