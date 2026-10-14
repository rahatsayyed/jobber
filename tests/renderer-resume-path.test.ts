import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error plain JS module with no type declarations
import { resolveResumePath, missingResumeMessage } from "../renderer/userData.js";

const root = path.resolve("/synthetic/project");
const rendererDir = path.join(root, "renderer");

describe("renderer resolveResumePath", () => {
  it("defaults to <root>/user-data/resume.json", () => {
    expect(resolveResumePath({}, rendererDir)).toBe(path.join(root, "user-data", "resume.json"));
  });

  it("resolves a relative JOBAPPLIER_USER_DATA against the project root", () => {
    expect(resolveResumePath({ JOBAPPLIER_USER_DATA: "my-data" }, rendererDir)).toBe(
      path.join(root, "my-data", "resume.json"),
    );
  });

  it("uses an absolute JOBAPPLIER_USER_DATA as is", () => {
    const abs = path.resolve("/synthetic/elsewhere");
    expect(resolveResumePath({ JOBAPPLIER_USER_DATA: abs }, rendererDir)).toBe(
      path.join(abs, "resume.json"),
    );
  });

  it("ignores a blank JOBAPPLIER_USER_DATA", () => {
    expect(resolveResumePath({ JOBAPPLIER_USER_DATA: "   " }, rendererDir)).toBe(
      path.join(root, "user-data", "resume.json"),
    );
  });
});

describe("renderer missingResumeMessage", () => {
  it("is a one-line fixed message about user-data and init", () => {
    const msg = missingResumeMessage(path.join(root, "user-data", "resume.json"));
    expect(msg).toContain("user-data");
    expect(msg).toContain("init");
    expect(msg).not.toContain("\n");
  });

  it("contains no path other than the one passed in", () => {
    const p = path.join(root, "user-data", "resume.json");
    const msg = missingResumeMessage(p);
    expect(msg.split(p).join("")).not.toMatch(/\/(Users|home)\//);
  });
});

describe("renderer sources no longer read resume.json from input/", () => {
  for (const f of ["index.js", "html.js"]) {
    it(`${f} does not join inputDir with resume.json`, () => {
      const src = fs.readFileSync(path.resolve(__dirname, "..", "renderer", f), "utf8");
      expect(src).not.toMatch(/path\.join\(inputDir,\s*["']resume\.json["']\)/);
    });
  }
});
