import { describe, it, expect } from 'vitest';
import { openDb, enqueueOutreachResult, listQueuedOutreach } from '../src/db.js';
import { stripMarkers, buildEmailParts, linksFromResume, MAX_MARKERS } from '../src/emailHtml.js';
import { checkTextWithNormalized } from '../src/resumeFacts.js';

const base = {
  website: { url: 'https://rahatsayyed.xyz', label: 'rahatsayyed.xyz' },
  social: {
    linkedin: { url: 'https://www.linkedin.com/in/rahatsayyed', label: 'linkedin.com/in/rahatsayyed' },
    github: { url: 'https://github.com/rahatsayyed', label: 'github.com/rahatsayyed' },
  },
};
const links = linksFromResume(base);

describe('stripMarkers', () => {
  it('removes **...** pairs and stray double stars', () => {
    expect(stripMarkers('I applied for the **Sr React role** and **cut load by 11s**.')).toBe('I applied for the Sr React role and cut load by 11s.');
    expect(stripMarkers('a ** b')).toBe('a  b');
  });
});

describe('buildEmailParts', () => {
  it('plain part is the text with markers stripped, nothing else', () => {
    const t = 'Hi,\n\nAbout the **Sr React role**.\n\nRahat';
    expect(buildEmailParts(t, links).plain).toBe(stripMarkers(t));
  });
  it('turns markers into <strong>, at most 3', () => {
    const { html } = buildEmailParts('**a** **b** **c** **d**', links);
    expect((html.match(/<strong>/g) ?? []).length).toBe(MAX_MARKERS);
    expect(html).toContain('d');
    expect(html).not.toContain('**');
  });
  it('escapes model HTML and adds no images or remote resources', () => {
    const { html } = buildEmailParts('Hi <script>alert(1)</script> <img src="http://x/t.png"> & **<b>x</b>**', links);
    expect(html).not.toMatch(/<script|<img|<b>|href="http:/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toMatch(/<link|<style|url\(/);
  });
  it('links the footer forms to the allowlisted full URLs', () => {
    const t = 'Hi\n\nPortfolio: https://rahatsayyed.xyz\nGitHub: github.com/rahatsayyed\nLinkedIn: @rahatsayyed\nGitHub: @rahatsayyed';
    const { html } = buildEmailParts(t, links);
    expect(html).toContain('<a href="https://rahatsayyed.xyz"');
    expect(html).toContain('<a href="https://github.com/rahatsayyed"');
    expect(html).toContain('<a href="https://www.linkedin.com/in/rahatsayyed"');
    expect((html.match(/href="https:\/\/github\.com\/rahatsayyed"/g) ?? []).length).toBe(2);
    expect(html).toContain('Portfolio: ');
  });
  it('links a bare site token but not a URL outside the allowlist, nor a handle on the wrong platform', () => {
    const { html } = buildEmailParts('See rahatsayyed.xyz or https://evil.example/x\nLinkedIn: @someoneelse\nGitHub: github.com/other', links);
    expect(html).toContain('<a href="https://rahatsayyed.xyz"');
    expect(html).not.toContain('evil.example"');
    expect(html).not.toMatch(/href="[^"]*(someoneelse|other)/);
    expect(html).toContain('https://evil.example/x');
  });
  it('keeps "- " lines as a list and paragraphs as <p>', () => {
    const { html } = buildEmailParts('Intro line\n\n- one\n- two\n\nBye\nRahat', links);
    expect(html).toMatch(/<ul[^>]*>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
    expect(html).toContain('<p');
    expect(html).toContain('Bye<br>Rahat');
  });
});

describe('gating sees the text without markers', () => {
  it('check_text gates the stripped text and returns the marked text to enqueue', () => {
    const r = checkTextWithNormalized('Hi, I cut load time by **11 seconds** at Copods.', { experience: [{ company: 'Copods', description: ['Cut initial load time by 11 seconds'] }] } as never);
    expect(r.normalized_text).toContain('**11 seconds**');
    const bad = checkTextWithNormalized('I improved revenue by **900%** at Copods.', { experience: [{ company: 'Copods', description: ['Cut initial load time by 11 seconds'] }] } as never);
    expect(bad.verdict).not.toBe('pass');
  });
});

describe('queue storage', () => {
  const add = (body: string, subject = 'Role at **Acme**') => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO jobs (id, source, title, company, url, apply_url, description, created_at) VALUES ('j','greenhouse','t','Acme','u','u','d','2026-10-01')").run();
    enqueueOutreachResult(db, {
      job_id: 'j', resume_pdf_path: null, email_subject: subject, email_body: body, email_to: 'a@acme.com', connect_note: null,
      connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: null, apply_url: null,
    }, links);
    return db;
  };
  it('stores plain body and subject without markers, and html with strong and links', () => {
    const db = add('Hi\n\nThe **Sr role**.\n\nGitHub: @rahatsayyed');
    const row = listQueuedOutreach(db)[0] as unknown as { email_subject: string; email_body: string; email_html: string };
    expect(row.email_subject).toBe('Role at Acme');
    expect(row.email_body).toBe('Hi\n\nThe Sr role.\n\nGitHub: @rahatsayyed');
    expect(row.email_html).toContain('<strong>Sr role</strong>');
    expect(row.email_html).toContain('href="https://github.com/rahatsayyed"');
  });
});
