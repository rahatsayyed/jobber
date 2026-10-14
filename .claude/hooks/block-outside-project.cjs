#!/usr/bin/env node
/**
 * PreToolUse hook: blocks Read/Write/Edit/NotebookEdit/Bash actions that touch
 * paths outside the project directory. Allows ~/.claude/** as an exception so
 * auto-memory, global CLAUDE.md, and skills keep working.
 */
const os = require("os");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const HOME = os.homedir();
const CLAUDE_HOME = path.join(HOME, ".claude");

const ALLOWED_ROOTS = [PROJECT_ROOT, CLAUDE_HOME];

function isAllowed(p) {
  const resolved = path.resolve(PROJECT_ROOT, p.replace(/^~(?=$|\/)/, HOME));
  return ALLOWED_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

function allow() {
  process.exit(0);
}

// Path-like tokens: absolute paths, ~/, ./, ../ segments. A match must start
// at a token boundary (start of string, whitespace, or a shell delimiter) so
// an embedded "/" inside a relative path (e.g. ".claude/settings.json") is
// never mistaken for a separate absolute path. Best-effort only.
const PATH_TOKEN_RE =
  /(?:^|(?<=[\s"'|&;<>()=]))(?:~\/|\.{1,2}\/|\/)[^\s"'|&;<>()]+/g;

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return allow();
  }

  const toolName = event.tool_name;
  const toolInput = event.tool_input || {};

  if (["Read", "Write", "Edit", "NotebookEdit"].includes(toolName)) {
    const filePath =
      toolInput.file_path || toolInput.notebook_path || toolInput.path;
    if (filePath && !isAllowed(filePath)) {
      return deny(
        `Blocked: ${toolName} targets "${filePath}", which is outside the project directory (${PROJECT_ROOT}) and outside ~/.claude.`
      );
    }
    return allow();
  }

  if (toolName === "Bash") {
    const command = toolInput.command || "";
    const tokens = command.match(PATH_TOKEN_RE) || [];
    for (const token of tokens) {
      // Skip pure flags/options accidentally matched (e.g. "-/") - unlikely given regex, but guard empty.
      if (!token || token === "/" ) continue;
      if (!isAllowed(token)) {
        return deny(
          `Blocked: Bash command references path "${token}", which resolves outside the project directory (${PROJECT_ROOT}) and outside ~/.claude. Command: ${command}`
        );
      }
    }
    return allow();
  }

  return allow();
});
