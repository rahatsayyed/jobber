import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import Handlebars from "handlebars";
import { resolveResumePath, missingResumeMessage } from "./userData.js";

const projectRoot = import.meta.dirname;
const folderArg = process.argv[2];
const inputDir = path.resolve(projectRoot, "input");
const outputDir = folderArg
  ? path.resolve(projectRoot, "automation", folderArg)
  : projectRoot;

const resumePath = folderArg
  ? path.join(outputDir, "resume.json")
  : resolveResumePath(process.env, projectRoot);
const templatePath = path.join(inputDir, "resume.template.html");
const htmlPath = path.join(outputDir, "resume.html");
const pdfPath = path.join(outputDir, "resume.pdf");

if (!fs.existsSync(resumePath)) {
  console.error(
    folderArg
      ? `Error: '${resumePath}' not found.`
      : missingResumeMessage(resumePath),
  );
  process.exit(1);
}

const resume = JSON.parse(fs.readFileSync(resumePath, "utf8"));

// Register partials (header and content components)
Handlebars.registerPartial(
  "header",
  fs.readFileSync(path.join(projectRoot, "components/header.html"), "utf8"),
);
Handlebars.registerPartial(
  "content",
  fs.readFileSync(path.join(projectRoot, "components/content.html"), "utf8"),
);

// Load template
const templateHtml = fs.readFileSync(templatePath, "utf8");
const template = Handlebars.compile(templateHtml);

// Render
// The template points at ./fonts/, which does not exist next to the per-job output; the files live in renderer/font.
const fontUrl = pathToFileURL(path.join(projectRoot, "font")).href;
const html = template(resume).replaceAll('url("./fonts/', `url("${fontUrl}/`);

// Save
fs.writeFileSync(htmlPath, html);
console.log(`✅ ${htmlPath} generated`);

// The PDF is printed by src/pdfRender.ts (headless installed Chrome through the shared launcher);
// run `npm run render` from the project root to produce both files.
