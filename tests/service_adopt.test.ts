import { describe, it, expect } from "bun:test";
import {
  isPinnedImage,
  parseServiceRequests,
  renderComposeYaml,
} from "../orchestrator/service_manager.ts";

describe("service auto-adopt", () => {
  it("accepts pinned tags and digests, rejects latest/floating", () => {
    expect(isPinnedImage("postgres:16-alpine")).toBe(true);
    expect(isPinnedImage("rabbitmq:3.13-management")).toBe(true);
    expect(isPinnedImage("elastic:8.13.0@sha256:abc123")).toBe(true);
    expect(isPinnedImage("redis:latest")).toBe(false);
    expect(isPinnedImage("redis")).toBe(false);
    expect(isPinnedImage("mongo:")).toBe(false);
  });

  it("validates a well-formed request list", () => {
    const { valid, rejected } = parseServiceRequests([
      { name: "elastic", image: "docker.elastic.co/elasticsearch/elasticsearch:8.13.0", env: { ELASTIC_URL: "http://localhost:9200" }, ports: ["9200:9200"] },
    ]);
    expect(rejected).toEqual([]);
    expect(valid.length).toBe(1);
    expect(valid[0].name).toBe("elastic");
    expect(valid[0].ports).toEqual(["9200:9200"]);
  });

  it("rejects unpinned images, bad ports, bad env, missing fields", () => {
    const { valid, rejected } = parseServiceRequests([
      { name: "bad1", image: "redis:latest" },
      { name: "bad2", image: "redis" },
      { name: "bad3", image: "redis:7-alpine", ports: ["notaport"] },
      { name: "bad4", image: "redis:7-alpine", env: { X: 42 } },
      { name: "", image: "redis:7-alpine" },
      { name: "bad6" },
    ]);
    expect(valid).toEqual([]);
    expect(rejected.length).toBe(6);
  });

  it("rejects a non-array payload with a reason", () => {
    const { valid, rejected } = parseServiceRequests({ foo: 1 });
    expect(valid).toEqual([]);
    expect(rejected.length).toBe(1);
  });

  it("renders multi-port customs under a single ports key", () => {
    const yaml = renderComposeYaml([
      { name: "broker", image: "rabbitmq:3.13-management", ports: ["5672:5672", "15672:15672"] },
    ]);
    expect(yaml.match(/ports:/g)?.length).toBe(1);
    expect(yaml).toContain('- "5672:5672"');
    expect(yaml).toContain('- "15672:15672"');
  });
});
