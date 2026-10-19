import fs from "fs";
import path from "path";
import Handlebars from "handlebars";
import { chromium } from "playwright";
import { resolveResumePath, missingResumeMessage } from "./userData.js";

const inputDir = path.resolve(process.cwd(), "input");
const outputDir = process.cwd();

const resumePath = resolveResumePath(process.env, process.cwd());
const templatePath = path.join(inputDir, "resume.template.html");
const htmlPath = path.join(outputDir, "resume.html");
const pdfPath = path.join(outputDir, "resume.pdf");

if (!fs.existsSync(resumePath)) {
  console.error(missingResumeMessage(resumePath));
  process.exit(1);
}

const resume = JSON.parse(fs.readFileSync(resumePath, "utf8"));

// Register partials (header and content components)
Handlebars.registerPartial(
  "header",
  fs.readFileSync(path.join(process.cwd(), "components/header.html"), "utf8"),
);
Handlebars.registerPartial(
  "content",
  fs.readFileSync(path.join(process.cwd(), "components/content.html"), "utf8"),
);

// Load template
const templateHtml = fs.readFileSync(templatePath, "utf8");
const template = Handlebars.compile(templateHtml);

// Render
const html = template(resume);

// Save
fs.writeFileSync(htmlPath, html);
console.log("✅ resume.html generated");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

await page.goto(`file://${htmlPath}`, {
  waitUntil: "load",
});

await page.pdf({
  path: pdfPath,
  format: "A4",
  printBackground: true,
});

await browser.close();
console.log("✅ resume.pdf generated");
