import path from "path";

// Mirrors src/lib/userData.ts (the renderer is plain JS and does not import
// from src/): JOBAPPLIER_USER_DATA when set (absolute, or relative to the
// project root; blank ignored), otherwise <project root>/user-data.
export function resolveResumePath(env = process.env, rendererDir) {
  const root = path.resolve(rendererDir, "..");
  const override = (env.JOBAPPLIER_USER_DATA ?? "").trim();
  const dir = override ? path.resolve(root, override) : path.join(root, "user-data");
  return path.join(dir, "resume.json");
}

export function missingResumeMessage(resumePath) {
  return `Error: '${resumePath}' not found. Run 'npm run user-data -- init' (or 'migrate') and fill in user-data/resume.json.`;
}
