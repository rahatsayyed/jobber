You are given a base resume as JSON (schema below), and a job posting. Produce ONLY the tailored resume as one JSON object with EXACTLY the same top-level keys and structure as the base resume (name, jobTitle, email, phone, summary, website, social, experience[{title,company,companyUrl,location,start,end,description}], education, skills[{category,items}], projects, certificates). Follow ONLY the rules below. The resume must fit ONE page when rendered (about 520-700 words total is typical; the renderer measures it). Never fabricate any company, title, date, degree, metric or skill that is not in the base resume. Output nothing but the JSON.

Base resume schema (types only; the actual base resume is given under INPUTS):

```
{
  "name": string, "jobTitle": string|null, "email": string, "phone": string,
  "website": {"url": string, "label": string},
  "social": {"<network>": {"url": string, "label": string}},
  "summary": string,
  "experience": [{"title": string, "company": string, "companyUrl": string, "location": string|null,
                  "start": string, "end": string, "description": [string]}],
  "projects": [],
  "education": [{"degree": string, "school": string, "location": string, "year": string}],
  "skills": [{"category": string, "items": [string]}],
  "certificates": []
}
```

INPUTS

BASE RESUME JSON:
{{BASE_RESUME_JSON}}

JOB TITLE: {{JOB_TITLE}}
COMPANY: {{COMPANY}}
JOB POSTING:
{{JOB_DESCRIPTION}}

