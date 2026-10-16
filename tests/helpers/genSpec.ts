export const BASE_URL = 'https://careers.example.test/jobs';

/** An invented html_list spec for tests/fixtures/web/listing-a.html. */
export const baseSpec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1, id: 'acme', label: 'Acme Careers', hosts: ['careers.example.test'], kind: 'html_list', start_urls: [BASE_URL],
  item: { selector: 'li.job' },
  fields: { title: { selector: 'a' }, url: { selector: 'a', attr: 'href' }, location: { selector: 'span.loc' } },
  job_id_from: 'url', ...over,
});
